#!/usr/bin/env python3
"""
Chromashift deploy script.

Uploads ./dist to the production test server using Paramiko + SFTP.

Usage:
    npm run build
    pip install -r requirements-deploy.txt
    python deploy.py                  # clean remote + upload (default)
    python deploy.py --dry-run        # list changes without mutating remote
    python deploy.py --no-clean       # upload without deleting remote files first

Authentication (in order of preference):
    1. SSH private key — DEPLOY_KEY env var (path to key file)
    2. SSH agent — SSH_AUTH_SOCK (e.g. ssh-add loaded keys)
    3. Password — DEPLOY_PASS env var (fallback)

Requirements:
    pip install -r requirements-deploy.txt
"""

from __future__ import annotations

import argparse
import os
import sys
from stat import S_ISDIR

try:
    import paramiko
except ImportError:
    print(
        "Error: paramiko is required. Install with: pip install -r requirements-deploy.txt",
        file=sys.stderr,
    )
    sys.exit(1)

# =============================================================================
# CONFIG
# =============================================================================

LOCAL_DIR = "dist"


def env_or_default(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value


HOST = env_or_default("DEPLOY_HOST", "1ink.us")
PORT = int(env_or_default("DEPLOY_PORT", "22"))
REMOTE_DIR = env_or_default("DEPLOY_REMOTE_DIR", "test.1ink.us/chromashift")

# Default: delete existing remote files before upload (disable with --no-clean).
CLEAN_BEFORE_UPLOAD = True

_KEY_CLASSES = (
    paramiko.Ed25519Key,
    paramiko.RSAKey,
    paramiko.ECDSAKey,
)


class DeployError(Exception):
    pass


def load_private_key(path: str) -> paramiko.PKey:
    """Load an SSH private key from disk without logging key material."""
    last_error: Exception | None = None
    for key_class in _KEY_CLASSES:
        try:
            return key_class.from_private_key_file(path)
        except paramiko.SSHException as exc:
            last_error = exc
    message = f"Could not load SSH private key at {path}"
    if last_error is not None:
        raise DeployError(message) from last_error
    raise DeployError(message)


def agent_keys() -> list[paramiko.PKey]:
    """Return keys offered by ssh-agent when SSH_AUTH_SOCK is available."""
    sock = os.environ.get("SSH_AUTH_SOCK")
    if not sock or not os.path.exists(sock):
        return []
    try:
        return list(paramiko.Agent().get_keys())
    except Exception:
        return []


def resolve_credentials() -> tuple[str, list[paramiko.PKey], str | None]:
    """
    Resolve deploy credentials from environment.

    Returns (username, private_keys, optional_password).
    Refuses placeholder values; password is optional when keys are available.
    """
    username = os.environ.get("DEPLOY_USER", "CHANGEME")
    password = os.environ.get("DEPLOY_PASS")
    key_path = os.environ.get("DEPLOY_KEY")

    if username in ("", "CHANGEME"):
        raise DeployError(
            "DEPLOY_USER is not set (or is still CHANGEME). "
            "Export a real SFTP username before deploying."
        )

    keys: list[paramiko.PKey] = []
    if key_path:
        if not os.path.isfile(key_path):
            raise DeployError(f"DEPLOY_KEY path does not exist: {key_path}")
        keys.append(load_private_key(key_path))

    keys.extend(agent_keys())

    password_ok = password not in (None, "", "CHANGEME")
    if keys:
        return username, keys, password if password_ok else None

    if not password_ok:
        raise DeployError(
            "No deploy credentials configured. Set DEPLOY_KEY (or use ssh-agent via "
            "SSH_AUTH_SOCK), or set DEPLOY_PASS as a fallback."
        )

    return username, [], password


def connect_transport(
    username: str,
    keys: list[paramiko.PKey],
    password: str | None,
) -> paramiko.Transport:
    """Open an authenticated Paramiko transport. Never logs secrets."""
    transport = paramiko.Transport((HOST, PORT))
    auth_errors: list[str] = []

    for key in keys:
        try:
            transport.connect(username=username, pkey=key)
            return transport
        except paramiko.AuthenticationException:
            auth_errors.append("key")
            transport.close()
            transport = paramiko.Transport((HOST, PORT))

    if password is not None:
        try:
            transport.connect(username=username, password=password)
            return transport
        except paramiko.AuthenticationException as exc:
            auth_errors.append("password")
            transport.close()
            raise DeployError(
                f"Authentication failed for {username}@{HOST} "
                f"(tried: {', '.join(auth_errors) or 'no methods'})"
            ) from exc

    transport.close()
    raise DeployError(
        f"Authentication failed for {username}@{HOST} "
        f"(tried: {', '.join(auth_errors) or 'no methods'})"
    )


def is_dir(sftp: paramiko.SFTPClient, path: str) -> bool:
    try:
        return S_ISDIR(sftp.stat(path).st_mode)
    except OSError:
        return False


def mkdir_p(sftp: paramiko.SFTPClient, remote_path: str, *, dry_run: bool) -> None:
    """Ensure remote directory exists (mkdir -p behaviour)."""
    parts: list[str] = []
    path = remote_path.rstrip("/")
    while path and path != "/":
        if is_dir(sftp, path):
            break
        parts.append(path)
        path = os.path.dirname(path)

    for directory in reversed(parts):
        if dry_run:
            print(f"  + would create remote dir: {directory}")
            continue
        try:
            sftp.mkdir(directory)
            print(f"  + created remote dir: {directory}")
        except OSError:
            pass


def list_remote_files(sftp: paramiko.SFTPClient, remote_path: str) -> list[str]:
    """Return remote file paths that would be removed by clean_dir."""
    paths: list[str] = []
    try:
        entries = sftp.listdir_attr(remote_path)
    except OSError as exc:
        print(f"  ! could not list {remote_path}: {exc}")
        return paths

    for entry in entries:
        full = f"{remote_path}/{entry.filename}"
        if S_ISDIR(entry.st_mode):
            paths.extend(list_remote_files(sftp, full))
            paths.append(full + "/")  # directory marker for ordering
        else:
            paths.append(full)

    # Deepest paths first so delete order mirrors clean_dir.
    paths.sort(key=lambda p: p.count("/"), reverse=True)
    return paths


def clean_dir(sftp: paramiko.SFTPClient, remote_path: str, *, dry_run: bool) -> None:
    """Recursively delete all contents of remote_path but keep the directory."""
    try:
        entries = sftp.listdir_attr(remote_path)
    except OSError as exc:
        print(f"  ! could not list {remote_path}: {exc}")
        return

    for entry in entries:
        full = f"{remote_path}/{entry.filename}"
        if S_ISDIR(entry.st_mode):
            clean_dir(sftp, full, dry_run=dry_run)
            if dry_run:
                print(f"  - would remove dir:  {full}")
            else:
                try:
                    sftp.rmdir(full)
                    print(f"  - removed dir:  {full}")
                except OSError:
                    pass
        elif dry_run:
            print(f"  - would remove file: {full}")
        else:
            try:
                sftp.remove(full)
                print(f"  - removed file: {full}")
            except OSError:
                pass


def iter_local_files(local_dir: str) -> list[tuple[str, str, int]]:
    """Return (local_path, remote_relative_path, size_bytes) for every file."""
    files: list[tuple[str, str, int]] = []
    for root, _, filenames in os.walk(local_dir):
        rel_root = os.path.relpath(root, local_dir)
        if rel_root == ".":
            rel_root = ""
        for name in filenames:
            local_file = os.path.join(root, name)
            rel_file = os.path.join(rel_root, name).replace(os.sep, "/")
            size = os.path.getsize(local_file)
            files.append((local_file, rel_file, size))
    files.sort(key=lambda item: item[1])
    return files


def format_bytes(num: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.1f} {unit}" if unit != "B" else f"{num} B"
        num /= 1024
    return f"{num:.1f} GB"


def upload_path(
    sftp: paramiko.SFTPClient,
    local_path: str,
    remote_path: str,
    rel: str,
    *,
    dry_run: bool,
) -> None:
    if dry_run:
        print(f"  > would upload: {rel}")
        return
    sftp.put(local_path, remote_path)
    print(f"  > {rel}")


def upload_recursive(
    sftp: paramiko.SFTPClient,
    local_dir: str,
    remote_dir: str,
    *,
    dry_run: bool,
) -> None:
    """Recursively upload local_dir tree into remote_dir."""
    mkdir_p(sftp, remote_dir, dry_run=dry_run)

    for root, dirs, files in os.walk(local_dir):
        rel_root = os.path.relpath(root, local_dir)
        if rel_root == ".":
            rel_root = ""

        remote_root = os.path.join(remote_dir, rel_root).replace(os.sep, "/").rstrip("/")

        for directory in dirs:
            mkdir_p(
                sftp,
                os.path.join(remote_root, directory).replace(os.sep, "/"),
                dry_run=dry_run,
            )

        for filename in files:
            local_file = os.path.join(root, filename)
            remote_file = os.path.join(remote_root, filename).replace(os.sep, "/")
            rel = os.path.relpath(local_file, local_dir)
            upload_path(sftp, local_file, remote_file, rel, dry_run=dry_run)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deploy Chromashift dist/ via SFTP.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List remote deletions and local uploads without mutating the server.",
    )
    parser.add_argument(
        "--no-clean",
        action="store_true",
        help="Skip deleting existing remote files before upload.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    clean_before_upload = CLEAN_BEFORE_UPLOAD and not args.no_clean

    try:
        base = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        base = os.getcwd()
    local = os.path.join(base, LOCAL_DIR)

    if not os.path.isdir(local):
        print(
            f"Error: {LOCAL_DIR}/ directory not found. Run 'npm run build' first.",
            file=sys.stderr,
        )
        sys.exit(1)

    index_html = os.path.join(local, "index.html")
    if not os.path.isfile(index_html):
        print(
            f"Warning: {LOCAL_DIR}/index.html is missing — is this a valid build?",
            file=sys.stderr,
        )

    try:
        username, keys, password = resolve_credentials()
    except DeployError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    local_files = iter_local_files(local)
    total_bytes = sum(size for _, _, size in local_files)

    auth_methods: list[str] = []
    if keys:
        auth_methods.append("ssh-key")
    if password is not None:
        auth_methods.append("password")

    mode = "DRY RUN" if args.dry_run else "DEPLOY"
    print(f"{mode}: {LOCAL_DIR}/  ->  {username}@{HOST}:{REMOTE_DIR}")
    print(f"Host: {HOST}:{PORT}")
    print(f"Auth: {', '.join(auth_methods)}")
    print(f"Upload: {len(local_files)} files ({format_bytes(total_bytes)})")
    if clean_before_upload:
        print("Remote clean: enabled")
    else:
        print("Remote clean: skipped (--no-clean)")
    sys.stdout.flush()

    try:
        transport = connect_transport(username, keys, password)
    except DeployError as exc:
        print(f"Connection failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except OSError as exc:
        print(f"Connection failed: {exc}", file=sys.stderr)
        sys.exit(1)

    sftp = paramiko.SFTPClient.from_transport(transport)

    try:
        if clean_before_upload:
            print("Cleaning remote target...")
            mkdir_p(sftp, REMOTE_DIR, dry_run=args.dry_run)
            if args.dry_run:
                for path in list_remote_files(sftp, REMOTE_DIR):
                    if path.endswith("/"):
                        print(f"  - would remove dir:  {path.rstrip('/')}")
                    else:
                        print(f"  - would remove file: {path}")
            else:
                clean_dir(sftp, REMOTE_DIR, dry_run=False)

        print("Uploading files...")
        upload_recursive(sftp, local, REMOTE_DIR, dry_run=args.dry_run)

        if args.dry_run:
            print("Dry run complete — no remote changes were made.")
        else:
            print("Done.")
    finally:
        sftp.close()
        transport.close()


if __name__ == "__main__":
    main()
