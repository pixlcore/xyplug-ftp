<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-ftp/refs/heads/main/logo.png" height="160" alt="FTP Transfer"/></p>
<h1 align="center">FTP Transfer</h1>

An FTP and FTPS event plugin for the [xyOps Workflow Automation System](https://xyops.io). It can upload, download, list, and delete files on remote FTP servers, and is designed to work naturally with xyOps job input and output files.

## Features

- Pure Node.js / `npx` plugin.
- Supports plain FTP, explicit FTPS, and implicit FTPS.
- Uses FTP passive mode for data transfers. Active mode is not supported by the underlying client library.
- Uploads files from the xyOps job temp directory by default.
- Downloads files into the xyOps job temp directory by default.
- Optionally attaches downloaded files to the xyOps job output.
- Supports filename glob filters, recursive folder traversal, max file limits, sorting, and age filters.
- Includes a dry run option for deletes.

## Requirements

- `Node.js`
- `npx`
- Network access from the xyOps runner host to your FTP or FTPS server

This plugin uses [`basic-ftp`](https://www.npmjs.com/package/basic-ftp) for FTP client support. The library is MIT licensed and has no runtime dependencies.

## Secrets / Environment Variables

Create a [Secret Vault](https://xyops.io/docs/secrets) in xyOps and assign this plugin to it. Add:

- `FTP_PASSWORD`

You can also enter a password directly in the plugin parameters, but a Secret Vault is recommended for production.

The plugin also honors `FTP_USER` from the environment when the Username parameter is blank.

## Data Collection

This plugin does not collect, store, or transmit telemetry, analytics, or usage metrics. It only connects to the FTP or FTPS server you configure. Your FTP server may log requests according to its own policies.

## Overview

The plugin exposes a toolset with four tools:

- [Upload Files](#upload-files)
- [Download Files](#download-files)
- [List Files](#list-files)
- [Delete Files](#delete-files)

All tools operate against a single configured FTP server per job run.

## Common Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `FTP Hostname` | Yes | Remote FTP hostname or IP address. |
| `Username` | No | FTP username. Defaults to `anonymous`. |
| `Password` | No | FTP password. Prefer `FTP_PASSWORD` in a xyOps Secret Vault. |
| `Port` | No | FTP TCP port. Defaults to `21`. |
| `Security Mode` | No | `Plain FTP`, `Explicit FTPS`, or `Implicit FTPS`. |
| `Reject Unauthorized TLS Certs` | No | Reject untrusted TLS certificates for FTPS. Enabled by default. |
| `Timeout (sec)` | No | Timeout for FTP commands. Defaults to `30`. |
| `Verbose Logging` | No | Logs FTP protocol details with passwords redacted. |
| `Allow Separate Transfer Host` | No | Advanced compatibility option for special FTP server setups. |

## General Notes

- FTP data transfers use passive mode. The underlying `basic-ftp` library tries EPSV first, then PASV where appropriate.
- Active FTP mode is not supported. This is usually fine for modern NAT, firewall, and container environments, where passive mode is the common choice.
- `Remote Path` values are FTP directories. Leave blank to use the server's login directory.
- `Filename Pattern` uses glob-style matching and is applied to filenames.
- Multiple filename patterns can be separated with commas, for example `*.csv,*.tsv`.
- `Older Than` and `Newer Than` can be raw seconds or friendly text like `7 days`, `12 hours`, or `30 minutes`.
- Some FTP servers do not provide reliable modification times. Age filters only include files with parseable modification dates.
- Progress is reported back to xyOps during file uploads and downloads.
- Plain FTP sends credentials and data without encryption. Use FTPS whenever your server supports it.

## Tool Reference

### Upload Files

Uploads local files to the FTP server.

In normal xyOps usage, if you leave `Local Path` blank, the plugin uploads files from the job temp directory. This means the easiest way to upload files is to attach them as job inputs or pass them from upstream workflow steps.

If you want to upload from a specific path on the server running the job, set `Local Path` explicitly. It can point to a file or a directory.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `Local Path` | No | Local file or directory to upload from. Leave blank to use the xyOps job temp directory. |
| `Filename Pattern` | No | Optional glob to limit which local files are uploaded. |
| `Remote Path` | No | Remote FTP directory to upload into. Leave blank for the login directory. |
| `Include Subfolders` | No | Upload matching files from subdirectories too, preserving relative paths. |

Output:

- `data.files`: Array of uploaded files with local path, remote path, filename, and size.
- `data.bytes`: Total uploaded bytes.
- `data.count`: Number of uploaded files.

### Download Files

Downloads files from the FTP server to the local machine running the job.

By default, if you leave `Local Path` blank, files are downloaded into the job temp directory. Also by default, `Attach Files` is enabled, so downloaded files are attached to the job output and become available to downstream workflow steps.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `Remote Path` | No | Remote FTP directory to download from. Leave blank for the login directory. |
| `Filename Pattern` | No | Optional glob to limit which remote files are downloaded. |
| `Local Path` | No | Destination directory on local disk. Leave blank to use the xyOps job temp directory. |
| `Include Subfolders` | No | Download matching files from subdirectories too, preserving relative paths. |
| `Delete Files` | No | Delete each remote file after successful download. |
| `Attach Files` | No | Attach downloaded files to the xyOps job output. Enabled by default. |
| `Maximum Files` | No | Limit how many files are downloaded. `0` means no limit. |
| `Sort Files` | No | Sort before downloading: `path`, `newest`, `oldest`, `largest`, or `smallest`. |

Output:

- `data.files`: Array of downloaded files with remote path, local path, filename, size, and modified time.
- `data.bytes`: Total downloaded bytes.
- `data.count`: Number of downloaded files.

### List Files

Lists remote FTP files and returns metadata without downloading contents.

This is useful for audits, preflight checks, inventory workflows, and driving downstream workflow logic from remote file state.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `Remote Path` | No | Remote FTP directory to list. Leave blank for the login directory. |
| `Filename Pattern` | No | Optional glob to limit which remote files are included. |
| `Include Subfolders` | No | List matching files from subdirectories too. |
| `Older Than` | No | Include only files older than this relative time. |
| `Newer Than` | No | Include only files newer than this relative time. |
| `Maximum Files` | No | Limit how many files are returned. `0` means no limit. |
| `Sort Files` | No | Sort before returning metadata: `path`, `newest`, `oldest`, `largest`, or `smallest`. |

Output:

- `data.files`: Array of remote file objects containing path, relative path, filename, size, and modification metadata.
- `data.bytes`: Total bytes across all matched files.
- `data.count`: Number of matched files.

The job details page also gets a compact file listing table for quick viewing.

### Delete Files

Deletes files from the FTP server.

Use this tool when you want to purge files matching a directory, filename pattern, age filter, or size/date ordering strategy. Start with `Dry Run` enabled when building destructive workflows.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `Remote Path` | No | Remote FTP directory to delete from. Leave blank for the login directory. |
| `Filename Pattern` | No | Optional glob to limit which remote files are deleted. |
| `Include Subfolders` | No | Delete matching files from subdirectories too. |
| `Older Than` | No | Delete only files older than this relative time. |
| `Newer Than` | No | Delete only files newer than this relative time. |
| `Maximum Files` | No | Limit how many files are deleted. `0` means no limit. |
| `Sort Files` | No | Sort before deleting: `oldest`, `newest`, `path`, `largest`, or `smallest`. |
| `Dry Run` | No | Preview the matched files without actually deleting anything. |

Output:

- `data.files`: Array of matched or deleted remote file objects.
- `data.bytes`: Total bytes across matched files.
- `data.count`: Number of matched or deleted files.
- `data.dry`: Whether dry run mode was enabled.

## Local Testing

When invoked by xyOps, the plugin expects a single JSON document on STDIN using the xyOps Wire Protocol. You can simulate this locally by piping JSON into `node index.js`.

Example upload test using the current directory as the local source:

```json
{
	"xy": 1,
	"params": {
		"hostname": "ftp.example.com",
		"username": "deploy",
		"port": 21,
		"secure": "false",
		"tool": "uploadFiles",
		"localPath": "./",
		"filespec": "*.txt",
		"remotePath": "incoming/"
	},
	"secrets": {
		"FTP_PASSWORD": "REPLACE_ME"
	}
}
```

Example download test:

```json
{
	"xy": 1,
	"params": {
		"hostname": "ftp.example.com",
		"username": "deploy",
		"port": 21,
		"secure": "true",
		"tool": "downloadFiles",
		"remotePath": "outgoing/",
		"localPath": "./downloads/",
		"filespec": "*.csv",
		"attach": false
	},
	"secrets": {
		"FTP_PASSWORD": "REPLACE_ME"
	}
}
```

Example list test:

```json
{
	"xy": 1,
	"params": {
		"hostname": "ftp.example.com",
		"username": "deploy",
		"port": 21,
		"secure": "true",
		"tool": "listFiles",
		"remotePath": "reports/",
		"filespec": "*.csv",
		"recursive": true,
		"newer": "24 hours",
		"sort": "newest",
		"max": 25
	},
	"secrets": {
		"FTP_PASSWORD": "REPLACE_ME"
	}
}
```

Example delete dry run:

```json
{
	"xy": 1,
	"params": {
		"hostname": "ftp.example.com",
		"username": "deploy",
		"port": 21,
		"secure": "true",
		"tool": "deleteFiles",
		"remotePath": "archive/",
		"filespec": "*.tmp",
		"older": "30 days",
		"dry": true
	},
	"secrets": {
		"FTP_PASSWORD": "REPLACE_ME"
	}
}
```

Run any of the above like this:

```sh
cat sample.json | node index.js
```

Or without a file:

```sh
echo '{"xy":1,"params":{"hostname":"ftp.example.com","username":"deploy","tool":"listFiles","remotePath":"incoming/","filespec":"*.csv"},"secrets":{"FTP_PASSWORD":"REPLACE_ME"}}' | node index.js
```

You can also use an environment variable for the password:

```sh
export FTP_PASSWORD="REPLACE_ME"
echo '{"xy":1,"params":{"hostname":"ftp.example.com","username":"deploy","tool":"listFiles"}}' | node index.js
```

## Output Summary

Depending on the selected tool, the plugin returns structured job `data` such as:

- uploaded file paths
- downloaded file metadata
- listed file metadata
- deleted file metadata
- total byte counts
- file counts

For file-producing tools, the plugin can also attach local files to the xyOps job output:

- `Download Files`: attaches downloaded files when `Attach Files` is enabled

## License

MIT
