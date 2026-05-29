#!/usr/bin/env node

// FTP Transfer Plugin for xyOps
// Copyright (c) 2026 PixlCore LLC
// MIT License

const fs = require('fs');
const Path = require('path');
const PosixPath = require('path').posix;
const ftp = require('basic-ftp');

const app = {
	client: null,
	finalSent: false,
	started: Date.now(),
	baseRemoteDir: '',
	progressDone: 0,
	progressTotal: 0,
	progressLabel: '',
	
	async run() {
		// Read the full xyOps job JSON from STDIN.
		const job = await readJob();
		this.job = job;
		this.params = job.params || {};
		this.secrets = collectSecrets(job);
		this.started = Date.now();
		
		// Validate the selected tool up front, so connection errors do not hide config mistakes.
		const tool = String(this.params.tool || '').trim();
		const func = 'tool_' + tool;
		if (!tool || !this[func]) {
			return this.fatal('tool', 'Unknown or missing tool: ' + (tool || '(none)'));
		}
		
		this.installSignalHandlers();
		await this.connect();
		
		// Let the selected tool do the actual FTP work.
		await this[func]();
	},
	
	async connect() {
		const host = String(this.params.hostname || '').trim();
		const user = String(this.params.username || process.env.FTP_USER || '').trim() || 'anonymous';
		const password = String(this.params.password || resolveNamedValue('FTP_PASSWORD', this.secrets) || 'guest');
		const port = toPositiveInt(this.params.port, 21);
		const timeout = toPositiveInt(this.params.timeout_sec, 30) * 1000;
		
		if (!host) return this.fatal('params', "Required parameter 'hostname' was not provided.");
		
		this.client = new ftp.Client(timeout, {
			allowSeparateTransferHost: toBool(this.params.allow_separate_transfer_host, false)
		});
		
		// Optional verbose logging is useful for troubleshooting server compatibility.
		// Passwords are redacted before they reach the xyOps job log.
		if (toBool(this.params.verbose, false)) {
			this.client.ftp.verbose = true;
			this.client.ftp.log = (message) => console.log(redactFtpLog(message));
		}
		
		console.log(`Connecting to FTP server: ${user}@${host}:${port}...`);
		
		await this.client.access({
			host,
			port,
			user,
			password,
			secure: parseSecureMode(this.params.secure),
			secureOptions: {
				rejectUnauthorized: toBool(this.params.reject_unauthorized, true)
			}
		});
		
		this.baseRemoteDir = await this.client.pwd();
		console.log(`Connected. Remote working directory: ${this.baseRemoteDir}`);
	},
	
	async tool_uploadFiles() {
		// Upload local files to the FTP server. Blank local path means xyOps job temp dir.
		const localPath = this.params.localPath || './';
		const remotePath = normalizeRemotePath(this.params.remotePath || '');
		const recursive = toBool(this.params.recursive, false);
		const matcher = makeGlobMatcher(this.params.filespec || '*');
		const files = await listLocalFiles(localPath, recursive, matcher);
		
		if (!files.length) {
			return this.sendFinal({
				code: 0,
				data: { files: [], bytes: 0, count: 0 }
			});
		}
		
		const uploaded = [];
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		this.setProgressTotal(bytes, 'uploading');
		
		for (const file of files) {
			const remoteFile = joinRemotePath(remotePath, file.relative);
			const remoteDir = PosixPath.dirname(remoteFile);
			
			this.setProgressLabel(`Uploading ${file.relative}`);
			await this.client.cd(this.baseRemoteDir);
			if (remoteDir && (remoteDir !== '.')) await this.client.ensureDir(remoteDir);
			this.trackTransferProgress(file.size, file.relative);
			await this.client.uploadFrom(file.path, PosixPath.basename(remoteFile));
			this.finishTransferProgress(file.size);
			
			uploaded.push({
				localPath: file.path,
				remotePath: remoteFile,
				filename: file.name,
				size: file.size
			});
		}
		
		this.sendFinal({
			code: 0,
			data: { files: uploaded, bytes, count: uploaded.length }
		});
	},
	
	async tool_downloadFiles() {
		// Download remote FTP files to local disk. Blank local path means xyOps job temp dir.
		const remotePath = normalizeRemotePath(this.params.remotePath || '');
		const localPath = Path.resolve(this.params.localPath || './');
		const recursive = toBool(this.params.recursive, false);
		const matcher = makeGlobMatcher(this.params.filespec || '*');
		const files = await this.selectRemoteFiles(remotePath, recursive, matcher);
		const downloaded = [];
		const attached = [];
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		
		this.setProgressTotal(bytes, 'downloading');
		
		for (const file of files) {
			const relPath = sanitizeRelativePath(recursive ? file.relative : file.name);
			const localFile = Path.resolve(localPath, fromPosixPath(relPath));
			
			this.setProgressLabel(`Downloading ${relPath}`);
			await ensureLocalDir(Path.dirname(localFile));
			this.trackTransferProgress(file.size, relPath);
			await this.client.downloadTo(localFile, file.path);
			this.finishTransferProgress(file.size);
			
			if (toBool(this.params.delete, false)) {
				await this.client.remove(file.path);
			}
			
			downloaded.push({
				remotePath: file.path,
				localPath: localFile,
				filename: file.name,
				size: file.size,
				modifiedAt: file.modifiedAt || ''
			});
			attached.push(localFile);
		}
		
		this.sendFinal({
			code: 0,
			files: toBool(this.params.attach, true) ? attached : [],
			data: { files: downloaded, bytes, count: downloaded.length }
		});
	},
	
	async tool_listFiles() {
		// List remote FTP files and return their metadata as job data.
		const remotePath = normalizeRemotePath(this.params.remotePath || '');
		const recursive = toBool(this.params.recursive, false);
		const matcher = makeGlobMatcher(this.params.filespec || '*');
		const files = await this.selectRemoteFiles(remotePath, recursive, matcher);
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		
		this.sendTable(files);
		this.sendFinal({
			code: 0,
			data: { files, bytes, count: files.length }
		});
	},
	
	async tool_deleteFiles() {
		// Delete remote FTP files, with an optional dry run for safe workflow testing.
		const remotePath = normalizeRemotePath(this.params.remotePath || '');
		const recursive = toBool(this.params.recursive, false);
		const dry = toBool(this.params.dry, false);
		const matcher = makeGlobMatcher(this.params.filespec || '*');
		const files = await this.selectRemoteFiles(remotePath, recursive, matcher);
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		const deleted = [];
		
		this.setProgressTotal(files.length, dry ? 'dry run' : 'deleting');
		
		for (const file of files) {
			this.setProgressLabel((dry ? 'Dry run: ' : 'Deleting ') + file.path);
			if (!dry) await this.client.remove(file.path);
			deleted.push(file);
			this.finishTransferProgress(1);
		}
		
		this.sendFinal({
			code: 0,
			data: { files: deleted, bytes, count: deleted.length, dry }
		});
	},
	
	async selectRemoteFiles(remotePath, recursive, matcher) {
		// Gather remote file metadata, then apply filters, sorting and max count.
		let files = await this.walkRemote(remotePath, recursive, remotePath);
		files = files.filter((file) => matcher(file.name));
		files = applyDateFilters(files, this.params.older, this.params.newer);
		files = sortFiles(files, this.params.sort || '');
		
		const max = toPositiveInt(this.params.max, 0);
		if (max > 0) files = files.slice(0, max);
		
		return files;
	},
	
	async walkRemote(remotePath, recursive, rootPath) {
		// Recursively list remote directories when requested. Directories are not returned.
		await this.client.cd(this.baseRemoteDir);
		
		let list = [];
		try {
			list = await this.client.list(remotePath);
		}
		catch (err) {
			throw new Error(`Failed to list remote path '${remotePath || this.baseRemoteDir}': ${err.message}`);
		}
		
		const files = [];
		for (const item of list) {
			if (!item || (item.name === '.') || (item.name === '..')) continue;
			
			const itemPath = joinRemotePath(remotePath, item.name);
			if (item.isDirectory && recursive) {
				const subFiles = await this.walkRemote(itemPath, recursive, rootPath);
				files.push(...subFiles);
			}
			else if (item.isFile) {
				files.push({
					name: item.name,
					path: itemPath,
					relative: relativeRemotePath(rootPath, itemPath),
					size: item.size || 0,
					modifiedAt: item.modifiedAt ? item.modifiedAt.toISOString() : '',
					rawModifiedAt: item.rawModifiedAt || ''
				});
			}
		}
		
		return files;
	},
	
	trackTransferProgress(size, label) {
		// basic-ftp reports byte counts for the active transfer.
		// xyOps wants overall progress from 0.0 to 1.0.
		this.client.trackProgress((info) => {
			if (!this.progressTotal) return;
			const done = Math.min(this.progressDone + info.bytes, this.progressTotal);
			this.sendUpdate({
				progress: done / this.progressTotal,
				status: `${titleCase(info.type || this.progressLabel)} ${label || info.name || ''}`.trim()
			});
		});
	},
	
	finishTransferProgress(amount) {
		this.client.trackProgress();
		this.progressDone += amount;
		if (this.progressTotal) {
			this.sendUpdate({
				progress: Math.min(this.progressDone / this.progressTotal, 1),
				status: this.progressLabel
			});
		}
	},
	
	setProgressTotal(total, label) {
		this.progressDone = 0;
		this.progressTotal = total || 0;
		this.progressLabel = label || '';
		if (this.progressTotal) this.sendUpdate({ progress: 0, status: titleCase(label) });
	},
	
	setProgressLabel(label) {
		this.progressLabel = label || '';
		if (label) this.sendUpdate({ status: label });
	},
	
	sendTable(files) {
		// Provide a small table for human-friendly job details, in addition to JSON data.
		const rows = files.slice(0, 100).map((file) => [
			file.path,
			formatBytes(file.size),
			file.modifiedAt || file.rawModifiedAt || ''
		]);
		
		this.sendUpdate({
			table: {
				title: 'FTP File Listing',
				header: ['Remote Path', 'Size', 'Modified'],
				rows,
				caption: files.length > 100 ? `Showing first 100 of ${files.length} files.` : `${files.length} file(s) found.`
			}
		});
	},
	
	sendUpdate(payload) {
		payload.xy = 1;
		console.log(JSON.stringify(payload));
	},
	
	fatal(code, description) {
		return this.sendFinal({ code, description });
	},
	
	sendFinal(payload) {
		if (this.finalSent) return;
		this.finalSent = true;
		payload.xy = 1;
		
		try {
			if (this.client) this.client.close();
		}
		catch (err) {
			// Ignore close errors while finishing the job.
		}
		
		process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0));
	},
	
	installSignalHandlers() {
		const handler = (signal) => {
			try {
				if (this.client) this.client.close();
			}
			catch (err) {
				// Ignore close errors during shutdown.
			}
			if (!this.finalSent) {
				this.finalSent = true;
				process.stdout.write(`${JSON.stringify({ xy: 1, code: `signal:${signal}`, description: `Plugin interrupted by ${signal}.` })}\n`);
			}
			setTimeout(() => process.exit(0), 100).unref();
		};
		
		process.once('SIGTERM', () => handler('SIGTERM'));
		process.once('SIGINT', () => handler('SIGINT'));
	}
};

async function readJob() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) fatalEarly('input', 'No JSON input received on STDIN.');
	
	try {
		return JSON.parse(raw);
	}
	catch (err) {
		fatalEarly('input', `Failed to parse JSON input: ${err.message}`);
	}
}

function collectSecrets(job) {
	const secrets = {};
	if (!job || !job.secrets || (typeof job.secrets !== 'object') || Array.isArray(job.secrets)) return secrets;
	
	for (const [key, value] of Object.entries(job.secrets)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		if ((value === undefined) || (value === null)) continue;
		secrets[key] = String(value);
	}
	
	return secrets;
}

function resolveNamedValue(name, secrets) {
	if (Object.prototype.hasOwnProperty.call(secrets, name)) return String(secrets[name]);
	if (Object.prototype.hasOwnProperty.call(process.env, name)) return String(process.env[name]);
	return '';
}

function parseSecureMode(value) {
	const text = String(value || 'false').trim().toLowerCase();
	if ((text === 'true') || (text === 'explicit') || (text === 'ftps')) return true;
	if (text === 'implicit') return 'implicit';
	return false;
}

function toBool(value, fallback) {
	if (value === undefined || value === null || value === '') return !!fallback;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return !!value;
	const text = String(value).trim().toLowerCase();
	if (/^(1|true|yes|y|on)$/.test(text)) return true;
	if (/^(0|false|no|n|off)$/.test(text)) return false;
	return !!fallback;
}

function toPositiveInt(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	const num = parseInt(value, 10);
	return Number.isFinite(num) && (num >= 0) ? num : fallback;
}

function normalizeRemotePath(remotePath) {
	return String(remotePath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function joinRemotePath(base, file) {
	const safeBase = normalizeRemotePath(base);
	const safeFile = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
	if (!safeBase) return safeFile;
	return PosixPath.join(safeBase, safeFile);
}

function relativeRemotePath(rootPath, filePath) {
	const root = normalizeRemotePath(rootPath);
	const file = normalizeRemotePath(filePath);
	if (!root) return file.replace(/^\/+/, '');
	if (file === root) return PosixPath.basename(file);
	if (file.indexOf(root + '/') === 0) return file.slice(root.length + 1);
	return PosixPath.basename(file);
}

function fromPosixPath(filePath) {
	return String(filePath || '').split('/').filter(Boolean).join(Path.sep);
}

function sanitizeRelativePath(filePath) {
	// Never allow remote listing names to escape the requested local download directory.
	const parts = String(filePath || '').split('/').filter((part) => part && (part !== '.') && (part !== '..'));
	return parts.join('/') || 'download';
}

async function ensureLocalDir(dir) {
	await fs.promises.mkdir(dir, { recursive: true });
}

async function listLocalFiles(localPath, recursive, matcher) {
	const resolved = Path.resolve(localPath || './');
	const stat = await fs.promises.stat(resolved);
	
	if (stat.isFile()) {
		const name = Path.basename(resolved);
		return matcher(name) ? [{
			path: resolved,
			name,
			relative: name,
			size: stat.size
		}] : [];
	}
	
	if (!stat.isDirectory()) return [];
	return walkLocalDir(resolved, resolved, recursive, matcher);
}

async function walkLocalDir(root, dir, recursive, matcher) {
	const entries = await fs.promises.readdir(dir, { withFileTypes: true });
	const files = [];
	
	for (const entry of entries) {
		const fullPath = Path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (recursive) {
				const subFiles = await walkLocalDir(root, fullPath, recursive, matcher);
				files.push(...subFiles);
			}
			continue;
		}
		
		if (!entry.isFile() || !matcher(entry.name)) continue;
		
		const stat = await fs.promises.stat(fullPath);
		files.push({
			path: fullPath,
			name: entry.name,
			relative: Path.relative(root, fullPath).split(Path.sep).join('/'),
			size: stat.size
		});
	}
	
	return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function makeGlobMatcher(pattern) {
	const text = String(pattern || '*').trim() || '*';
	const patterns = text.split(',').map((item) => item.trim()).filter(Boolean);
	const regexes = patterns.map(globToRegExp);
	
	return function(filename) {
		return regexes.some((regex) => regex.test(filename));
	};
}

function globToRegExp(glob) {
	let output = '^';
	let i = 0;
	
	while (i < glob.length) {
		const char = glob[i++];
		if (char === '*') {
			if (glob[i] === '*') {
				i++;
				output += '.*';
			}
			else output += '[^/]*';
		}
		else if (char === '?') output += '[^/]';
		else output += escapeRegExp(char);
	}
	
	output += '$';
	return new RegExp(output);
}

function escapeRegExp(char) {
	return char.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function applyDateFilters(files, older, newer) {
	const olderSec = parseAgeSeconds(older);
	const newerSec = parseAgeSeconds(newer);
	if (!olderSec && !newerSec) return files;
	
	const now = Date.now();
	return files.filter((file) => {
		if (!file.modifiedAt) return false;
		const mtime = Date.parse(file.modifiedAt);
		if (!Number.isFinite(mtime)) return false;
		if (olderSec && !(mtime < (now - (olderSec * 1000)))) return false;
		if (newerSec && !(mtime > (now - (newerSec * 1000)))) return false;
		return true;
	});
}

function parseAgeSeconds(value) {
	if (value === undefined || value === null || value === '') return 0;
	if (typeof value === 'number') return value > 0 ? value : 0;
	const text = String(value).trim().toLowerCase();
	if (!text) return 0;
	if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
	
	const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/);
	if (!match) return 0;
	
	const amount = Number(match[1]);
	const unit = match[2];
	if (/^s/.test(unit)) return amount;
	if (/^m/.test(unit)) return amount * 60;
	if (/^h/.test(unit)) return amount * 3600;
	if (/^d/.test(unit)) return amount * 86400;
	if (/^w/.test(unit)) return amount * 604800;
	return 0;
}

function sortFiles(files, sortMode) {
	const mode = String(sortMode || '').trim().toLowerCase();
	const list = files.slice();
	
	if (mode === 'newest') {
		list.sort((a, b) => Date.parse(b.modifiedAt || 0) - Date.parse(a.modifiedAt || 0));
	}
	else if (mode === 'oldest') {
		list.sort((a, b) => Date.parse(a.modifiedAt || 0) - Date.parse(b.modifiedAt || 0));
	}
	else if (mode === 'largest') {
		list.sort((a, b) => b.size - a.size);
	}
	else if (mode === 'smallest') {
		list.sort((a, b) => a.size - b.size);
	}
	else {
		list.sort((a, b) => a.path.localeCompare(b.path));
	}
	
	return list;
}

function formatBytes(bytes) {
	const value = Number(bytes) || 0;
	if (value < 1024) return value + ' B';
	if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
	if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB';
	return (value / 1073741824).toFixed(1) + ' GB';
}

function titleCase(text) {
	text = String(text || '');
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function redactFtpLog(message) {
	return String(message || '').replace(/(PASS\s+).*/i, '$1********');
}

function fatalEarly(code, description) {
	process.stdout.write(`${JSON.stringify({ xy: 1, code, description })}\n`);
	process.exit(0);
}

app.run().catch((err) => {
	console.error(err);
	return app.fatal('error', err && err.message ? err.message : 'Unknown error');
});
