"""为容器准备固定版本素材；脚本目录与不受信任的下载、解压目录隔离。"""

import argparse
import collections
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

RELEASE = json.loads((Path(__file__).resolve().parents[2] / "shared/asset-release.json").read_text(encoding="utf-8"))
RELEASE_URL, RELEASE_SIZE, RELEASE_SHA256 = RELEASE["url"], RELEASE["size"], RELEASE["sha256"]
PREFIX = RELEASE["prefix"]
MANIFESTS = ("assets.json", "local-assets.json", "local-fx.json")
MAX_EXPANDED = 4 * 1024**3
MAX_FILE = 256 * 1024**2
MAX_ENTRIES = 100000


class RemoteArchive(io.RawIOBase):
    """只读远程压缩包；仅供检查目录与少量清单，不代替完整下载哈希验证。"""

    def __init__(self):
        """建立固定包的游标；首次小范围请求解析跳转，不下载整个素材包。"""
        super().__init__()
        self.position = 0
        self.url = RELEASE_URL

    def seekable(self):
        """允许标准压缩包读取器定位目录和清单。"""
        return True

    def tell(self):
        """返回远程字节游标，不访问网络。"""
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        """按压缩包约定移动游标；非法范围立即报错。"""
        position = offset if whence == io.SEEK_SET else self.position + offset if whence == io.SEEK_CUR else RELEASE_SIZE + offset
        if not 0 <= position <= RELEASE_SIZE:
            raise ValueError("远程压缩包定位越界")
        self.position = position
        return position

    def read(self, size=-1):
        """读取指定范围并验证服务器确实返回部分内容；拒绝意外的整包响应。"""
        size = RELEASE_SIZE - self.position if size < 0 else min(size, RELEASE_SIZE - self.position)
        if not size:
            return b""
        if size > 32 * 1024 * 1024:
            raise ValueError("检查请求超过三十二兆字节")
        end = self.position + size - 1
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{end}", "User-Agent": "Stronghold-asset-inspector"})
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 206 or response.headers.get("Content-Range") != f"bytes {self.position}-{end}/{RELEASE_SIZE}":
                raise ValueError("素材源未满足精确范围请求")
            self.url = response.url
            data = response.read(size + 1)
        if len(data) != size:
            raise ValueError("远程压缩包范围长度不符")
        self.position += size
        return data


def inspect_release():
    """读取固定包目录及三份清单结构并输出，不写入磁盘或执行包内文件。"""
    with zipfile.ZipFile(RemoteArchive()) as archive:
        counts = collections.Counter("/".join(entry.filename.split("/")[:3]) for entry in archive.infolist())
        print(json.dumps({"entries": len(archive.infolist()), "directories": counts.most_common(20)}, ensure_ascii=False))
        selected = asset_members(archive)
        available = {relative for entry, relative in selected if not entry.is_dir()}
        references = set()
        for name in MANIFESTS:
            document = json.loads(archive.read(PREFIX + "data/" + name))
            references.update(referenced_files(document))
            print(json.dumps({"manifest": name, "keys": list(document), "sample": str(document)[:600]}, ensure_ascii=False))
        missing = references - available
        if missing:
            raise ValueError(f"固定包缺少顶层清单引用：{sorted(missing)[:10]}")
        fonts = [relative for relative in available if relative.startswith("public/fonts/") and relative.endswith(".css")]
        print(json.dumps({"selected": len(selected), "expandedBytes": sum(entry.file_size for entry, _ in selected), "topReferences": len(references), "fontStyles": sorted(fonts)}, ensure_ascii=False))
        for relative in sorted(fonts):
            print(json.dumps({"fontStyle": relative, "content": archive.read(PREFIX + relative).decode("utf-8")[:2000]}, ensure_ascii=False))


def safe_path(name):
    """将压缩包路径按严格的相对路径契约解析，拒绝越界、空段及平台别名。"""
    parts = name.rstrip("/").split("/")
    if not parts or any(part in ("", ".", "..") or ":" in part or part.endswith((".", " ")) for part in parts) or "\\" in name or "\x00" in name:
        raise ValueError(f"压缩包路径非法：{name}")
    return PurePosixPath(*parts)


def asset_members(archive):
    """审核全部目录路径，仅返回素材、字体和三份清单；不执行或解压其他内容。"""
    if len(archive.infolist()) > MAX_ENTRIES:
        raise ValueError("压缩包条目数超限")
    selected, names, total = [], set(), 0
    for entry in archive.infolist():
        # 即便忽略的源码条目也不得包含越界路径，防止未来白名单扩大时引入隐患。
        safe_path(entry.filename)
        if not entry.filename.startswith(PREFIX):
            raise ValueError("压缩包根目录不匹配")
        relative = entry.filename[len(PREFIX):]
        allowed = relative.startswith(("public/assets/", "public/fonts/")) or relative in {"data/" + name for name in MANIFESTS}
        if not allowed:
            continue
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or entry.flag_bits & 1:
            raise ValueError(f"素材必须是普通文件或目录：{relative}")
        key = relative.rstrip("/").casefold()
        if key in names:
            raise ValueError(f"素材路径重复或大小写冲突：{relative}")
        names.add(key)
        total += entry.file_size
        if entry.file_size > MAX_FILE or total > MAX_EXPANDED or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError("素材展开体积或压缩方式不受支持")
        selected.append((entry, relative))
    if not all("data/" + name in names for name in MANIFESTS):
        raise ValueError("固定包缺少素材清单")
    return selected


def referenced_files(value):
    """遍历已解析清单内的站内素材引用；非素材业务字符串不参与路径解释。"""
    result = set()
    pending = [value]
    while pending:
        # 显式栈避免清单树过深导致递归溢出，每轮只检查一个节点。
        current = pending.pop()
        if isinstance(current, dict):
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
        elif isinstance(current, str) and current.startswith(("/assets/", "/fonts/")):
            decoded = urllib.parse.unquote(current, errors="strict")
            if "?" in decoded or "#" in decoded:
                raise ValueError(f"素材引用不得带查询或片段：{current}")
            result.add("public/" + str(safe_path(decoded[1:])))
    return result


def validate_bundle(bundle):
    """校验清单及引用闭包，包含本地特效嵌套清单与字体样式中的相对文件。"""
    manifest_hashes, references = {}, set()
    for name in MANIFESTS:
        content = (bundle / "data" / name).read_bytes()
        manifest_hashes[name] = hashlib.sha256(content).hexdigest()
        references.update(referenced_files(json.loads(content)))
    seen, pending = set(), list(references)
    while pending:
        # 每个文件只展开一次，避免对数万条素材引用反复求集合差导致平方级开销。
        relative = pending.pop()
        if relative in seen:
            continue
        seen.add(relative)
        file = bundle.joinpath(*safe_path(relative).parts)
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"清单引用的素材缺失或不是普通文件：{relative}")
        if file.suffix.lower() == ".json":
            pending.extend(referenced_files(json.loads(file.read_text(encoding="utf-8"))))
        elif relative.startswith("public/fonts/") and file.suffix.lower() == ".css":
            for match in re.finditer(r"url\(\s*[\x27\x22]?([^\x27\x22\s)]+)", file.read_text(encoding="utf-8")):
                # 字体引用可能是绝对素材地址或当前目录相对地址，均不能访问外部网络。
                url = match.group(1)
                if url.startswith(("/assets/", "/fonts/")):
                    pending.extend(referenced_files(url))
                else:
                    pending.append(str(PurePosixPath(relative).parent / safe_path(url)))
    return manifest_hashes, len(seen)


def verify_archive(file):
    """流式复算完整包大小及固定哈希；摘要不符时不得打开压缩包。"""
    if file.stat().st_size != RELEASE_SIZE:
        raise ValueError("完整素材包大小不符")
    with file.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != RELEASE_SHA256:
            raise ValueError("完整素材包哈希不符")


def download_archive(destination):
    """下载一次固定完整包到私有临时目录；超限、网络或哈希错误直接失败，不重试。"""
    request = urllib.request.Request(RELEASE_URL, headers={"User-Agent": "Stronghold-asset-init"})
    total = 0
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("xb") as output:
        if response.status != 200:
            raise ValueError("完整素材包下载响应错误")
        while block := response.read(1024 * 1024):
            # 网络源不能用无限响应耗尽磁盘，达到固定发布体积后不再接受字节。
            total += len(block)
            if total > RELEASE_SIZE:
                raise ValueError("完整素材包下载体积超限")
            output.write(block)
    verify_archive(destination)


def extract_assets(archive, bundle):
    """仅按审核后的白名单逐个写入全新临时目录，返回实际普通文件数及字节数。"""
    count, total = 0, 0
    for entry, relative in asset_members(archive):
        destination = bundle.joinpath(*safe_path(relative).parts)
        if entry.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, destination.open("xb") as output:
                # 读取到结尾会核对压缩包校验码，实际字节数还须符合目录声明。
                copied = 0
                while block := source.read(1024 * 1024):
                    copied += len(block)
                    if copied > entry.file_size:
                        raise ValueError("素材实际展开体积超过声明")
                    output.write(block)
                if copied != entry.file_size:
                    raise ValueError("素材实际展开体积不足")
            count += 1
            total += copied
    return count, total


def initialize(root, archive_path=None):
    """互斥初始化版本目录并原子发布；已有完整版本只校验，不重新下载。"""
    if os.name != "posix":
        raise RuntimeError("正式初始化需要支持文件锁的 Linux 容器；本机仅可运行检查或单元测试")
    import fcntl

    root = root.resolve(strict=True)
    target = root / RELEASE["directory"]
    with (root / ".init.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if target.exists():
            marker = json.loads((target / "complete.json").read_text(encoding="utf-8"))
            hashes, references = validate_bundle(target)
            if marker.get("version") != RELEASE["version"] or marker.get("sha256") != RELEASE_SHA256 or marker.get("manifests") != hashes:
                raise ValueError("已有素材版本标记损坏；停止启动，不自动覆盖")
            print(json.dumps({"ready": str(target), "reused": True, "references": references}))
            return
        work = Path(tempfile.mkdtemp(prefix=".init-", dir=root))
        try:
            archive_path = archive_path.resolve(strict=True) if archive_path else work / "release.zip"
            if archive_path.exists():
                verify_archive(archive_path)
            else:
                download_archive(archive_path)
            bundle = work / "bundle"
            bundle.mkdir()
            with zipfile.ZipFile(archive_path) as archive:
                count, total = extract_assets(archive, bundle)
            hashes, references = validate_bundle(bundle)
            marker = {"version": RELEASE["version"], "sha256": RELEASE_SHA256, "files": count, "bytes": total, "manifests": hashes}
            with (bundle / "complete.json").open("x", encoding="utf-8") as output:
                json.dump(marker, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(bundle, target)
            print(json.dumps({"ready": str(target), "reused": False, "references": references}))
        finally:
            # 只删除本次锁内新建的临时目录；不清理历史残留或其他版本。
            if work.parent != root or not work.name.startswith(".init-"):
                raise ValueError("临时清理路径不在素材根内")
            shutil.rmtree(work)


def main():
    """解析显式检查入口；运行时必须使用 Python 隔离模式。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect-release", action="store_true")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("必须使用 python -I 隔离模式")
    if args.inspect_release:
        inspect_release()
    elif args.root is not None and args.root.is_absolute():
        initialize(args.root, args.archive)
    else:
        parser.error("必须提供绝对 --root 或显式 --inspect-release")


if __name__ == "__main__":
    main()
