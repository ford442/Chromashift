#!/usr/bin/env python3
"""
Chromashift deploy script.

Uploads ./dist to the production test server using Paramiko + SFTP.

Usage:
    npm run build
    python deploy.py

Requirements:
    pip install paramiko
"""

import os
import sys
from stat import S_ISDIR

try:
    import paramiko
except ImportError:
    print("Error: paramiko is required. Install with: pip install paramiko", file=sys.stderr)
    sys.exit(1)

# =============================================================================
# CONFIG - hard-coded credentials as per project deployment convention.
# SECURITY NOTE: This file contains credentials. Treat as sensitive.
# Do not commit real passwords to public repositories.
# =============================================================================

HOST = "1ink.us"
PORT = 22
USERNAME = os.environ.get("DEPLOY_USER") or "CHANGEME"   # <-- set your SFTP username for 1ink.us (or use DEPLOY_USER env)
PASSWORD = os.environ.get("DEPLOY_PASS") or "CHANGEME"   # <-- hard-coded password (as described in AGENTS.md) (or use DEPLOY_PASS env)

LOCAL_DIR = "dist"
REMOTE_DIR = "test.1ink.us/chromashift"

# Set to True to delete existing files on the server before uploading (recommended)
CLEAN_BEFORE_UPLOAD = True


def is_dir(sftp, path):
    try:
        return S_ISDIR(sftp.stat(path).st_mode)
    except Exception:
        return False


def mkdir_p(sftp, remote_path):
    """Ensure remote directory exists (mkdir -p behaviour)."""
    parts = []
    path = remote_path.rstrip("/")
    while path and path != "/":
        try:
            if is_dir(sftp, path):
                break
        except Exception:
            pass
        parts.append(path)
        path = os.path.dirname(path)
    for d in reversed(parts):
        try:
            sftp.mkdir(d)
            print(f"  + created remote dir: {d}")
        except Exception:
            # May already exist or parent created it
            pass


def clean_dir(sftp, remote_path):
    """Recursively delete all contents of remote_path but keep the directory."""
    try:
        entries = sftp.listdir_attr(remote_path)
    except Exception as e:
        print(f"  ! could not list {remote_path}: {e}")
        return

    for entry in entries:
        full = f"{remote_path}/{entry.filename}"
        if S_ISDIR(entry.st_mode):
            clean_dir(sftp, full)
            try:
                sftp.rmdir(full)
                print(f"  - removed dir:  {full}")
            except Exception:
                pass
        else:
            try:
                sftp.remove(full)
                print(f"  - removed file: {full}")
            except Exception:
                pass


def upload_path(sftp, local_path, remote_path, local_base):
    """Upload a single file."""
    sftp.put(local_path, remote_path)
    rel = os.path.relpath(local_path, local_base)
    print(f"  > {rel}")


def upload_recursive(sftp, local_dir, remote_dir):
    """Recursively upload local_dir tree into remote_dir."""
    mkdir_p(sftp, remote_dir)

    for root, dirs, files in os.walk(local_dir):
        rel_root = os.path.relpath(root, local_dir)
        if rel_root == ".":
            rel_root = ""

        remote_root = os.path.join(remote_dir, rel_root).replace(os.sep, "/").rstrip("/")

        # Ensure any subdirectories exist
        for d in dirs:
            mkdir_p(sftp, os.path.join(remote_root, d).replace(os.sep, "/"))

        # Upload files
        for f in files:
            local_file = os.path.join(root, f)
            remote_file = os.path.join(remote_root, f).replace(os.sep, "/")
            upload_path(sftp, local_file, remote_file, local_dir)


def main():
    # Robust base dir (works when run as script or in some exec contexts)
    try:
        base = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        base = os.getcwd()
    local = os.path.join(base, LOCAL_DIR)

    if not os.path.isdir(local):
        print(f"Error: {LOCAL_DIR}/ directory not found. Run 'npm run build' first.", file=sys.stderr)
        sys.exit(1)

    index_html = os.path.join(local, "index.html")
    if not os.path.isfile(index_html):
        print(f"Warning: {LOCAL_DIR}/index.html is missing — is this a valid build?", file=sys.stderr)

    if USERNAME in ("CHANGEME", "") or PASSWORD in ("CHANGEME", ""):
        print("Error: Please set real credentials in deploy.py (USERNAME / PASSWORD) or use DEPLOY_USER / DEPLOY_PASS env vars.", file=sys.stderr)
        sys.exit(1)

    print(f"Deploying: {LOCAL_DIR}/  ->  {USERNAME}@{HOST}:{REMOTE_DIR}")
    print(f"Host: {HOST}:{PORT}")

    transport = paramiko.Transport((HOST, PORT))
    try:
        transport.connect(username=USERNAME, password=PASSWORD)
    except Exception as e:
        print(f"Connection failed: {e}", file=sys.stderr)
        sys.exit(1)

    sftp = paramiko.SFTPClient.from_transport(transport)

    try:
        if CLEAN_BEFORE_UPLOAD:
            print("Cleaning remote target...")
            # Ensure the target dir exists first so we can clean it
            mkdir_p(sftp, REMOTE_DIR)
            clean_dir(sftp, REMOTE_DIR)

        print("Uploading files...")
        upload_recursive(sftp, local, REMOTE_DIR)
        print("Done.")
    finally:
        sftp.close()
        transport.close()


if __name__ == "__main__":
    main()
