import hashlib
import json
from pathlib import Path
from shutil import copyfile
import subprocess
import sys
from tempfile import TemporaryDirectory

from drive import CLIENT_VERSION


def main():
    if sys.platform != 'win32':
        raise SystemExit('请在 Windows 上构建客户端。')
    project = Path(__file__).resolve().parents[1]
    release = project / 'release'
    release.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix='.windows-build-', dir=release) as directory:
        staging = Path(directory)
        subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--windowed',
                        '--name', 'LanDrive', '--distpath', str(staging), '--workpath', str(staging / 'build'),
                        '--specpath', str(staging), 'client/drive.py'], cwd=project, check=True)
        installer = staging / 'LanDrive.exe'
        result = staging / 'self-check.txt'
        subprocess.run([str(installer), '--self-check', str(result)], cwd=project, check=True, timeout=60)
        if not result.is_file() or result.read_text(encoding='ascii') != 'OK':
            raise SystemExit('客户端自检失败，未发布更新。')
        with installer.open('rb') as file:
            digest = hashlib.file_digest(file, 'sha256').hexdigest()
        artifact = f'LanDrive-{CLIENT_VERSION}-{digest[:12]}.exe'
        manifest = {'version': CLIENT_VERSION, 'size': installer.stat().st_size, 'sha256': digest, 'artifact': artifact}
        (staging / 'windows.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        copyfile(installer, staging / artifact)
        (staging / artifact).replace(release / artifact)
        # 旧服务仍从固定文件名提供客户端。
        installer.replace(release / installer.name)
        (staging / 'windows.json').replace(release / 'windows.json')
        print(release / artifact)


if __name__ == '__main__':
    main()
