import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import current_thread
from time import monotonic, sleep
import tkinter as tk
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError
from uuid import uuid4

try:
    from client.drive import APIError, CLIENT_VERSION, Client, DriveAPI, load_jobs, persist, release_version, step_download, step_upload
except ModuleNotFoundError:
    DriveAPI = None


class WindowsClientTest(unittest.TestCase):
    def test_release_metadata_requires_valid_version_and_digest(self):
        valid = {'version': '1.12.0', 'size': 16, 'sha256': 'a' * 64}
        self.assertEqual(release_version(valid), (1, 12, 0))
        for invalid in (None, [], {**valid, 'size': True}, {**valid, 'version': '../1.12.0'}, {**valid, 'sha256': 'bad'}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(APIError, '版本信息'):
                release_version(invalid)

    def test_update_retries_stream_failure_and_reports_progress(self):
        bundle = b'a' * (256 * 1024) + b'b'
        release = {'version': '1.12.0', 'size': len(bundle), 'sha256': hashlib.sha256(bundle).hexdigest()}
        api = DriveAPI('127.0.0.1:8080')
        interrupted = BytesIO(bundle)
        interrupted.read = Mock(side_effect=[bundle[:-1], URLError('中断')])
        api.opener.open = Mock(side_effect=[interrupted, BytesIO(bundle)])
        with tempfile.TemporaryDirectory(prefix='lan-drive-update-') as directory:
            target = Path(directory) / 'LanDrive.exe'
            target.write_bytes(b'previous release')
            progress = []

            def report(received, total):
                self.assertEqual(target.read_bytes(), b'previous release')
                progress.append((received, total))

            with patch('client.drive.time.sleep'):
                self.assertEqual(api.download_release(release, target, report), target)
            self.assertEqual(api.opener.open.call_count, 2)
            self.assertEqual(progress.count((0, len(bundle))), 2)
            self.assertEqual(progress[-1], (len(bundle), len(bundle)))
            self.assertEqual(target.read_bytes(), bundle)
            self.assertEqual(list(Path(directory).glob('*.part')), [])

    def test_about_checks_downloads_and_runs_newer_release(self):
        with tempfile.TemporaryDirectory(prefix='lan-drive-client-update-') as directory:
            root = tk.Tk()
            root.withdraw()
            try:
                client = Client(root, Path(directory))
                client.api = DriveAPI('127.0.0.1:8080')
                client.workspace({'name': '验收用户'})
                target = Path(directory) / 'LanDrive-1.12.0.exe'
                bundle = b'new release'
                release = {'version': '1.12.0', 'size': len(bundle), 'sha256': hashlib.sha256(bundle).hexdigest()}
                client.api.request = Mock(return_value=release)
                client.api.opener.open = Mock(return_value=BytesIO(bundle))

                def wait_for_update():
                    deadline = monotonic() + 5
                    while client.updating and monotonic() < deadline:
                        root.update()
                        sleep(0.02)
                    self.assertFalse(client.updating, client.update_note.get())

                client.check_update()
                wait_for_update()
                self.assertIn('v1.12.0', client.update_note.get())
                with patch('client.drive.filedialog.asksaveasfilename', return_value=str(target)):
                    client.update_action.invoke()
                wait_for_update()
                self.assertEqual(client.update_percent.get(), 100)
                self.assertEqual(target.read_bytes(), bundle)
                self.assertEqual(client.update_action.cget('text'), '运行新版')
                with patch('client.drive.subprocess.Popen') as launch, patch.object(root, 'destroy') as close:
                    client.jobs['active'] = {'status': 'transferring'}
                    client.update_action.invoke()
                    launch.assert_not_called()
                    client.jobs.clear()
                    client.update_action.invoke()
                    launch.assert_called_once_with([str(target)], cwd=target.parent)
                    close.assert_called_once()
            finally:
                root.destroy()

    def test_workspace_exposes_separate_history_tabs(self):
        with tempfile.TemporaryDirectory(prefix='lan-drive-client-history-') as directory:
            root = tk.Tk()
            root.withdraw()
            try:
                client = Client(root, Path(directory))
                client.api = DriveAPI('127.0.0.1:8080')
                client.workspace({'name': '验收用户'})
                tabs = [client.notebook.tab(tab, 'text') for tab in client.notebook.tabs()]
                self.assertEqual(tabs[-2:], ['上传记录', '下载记录'])
                for history in client.history.values():
                    self.assertEqual(history['remove'].cget('text'), '删除选中')
                    self.assertEqual(history['clear'].cget('text'), '清空记录')
                    self.assertTrue(history['clear'].instate(['disabled']))
                self.assertEqual(client.update_button.cget('text'), '检查更新')
                client.about()
                self.assertIn(f'v{CLIENT_VERSION}', client.about_window.title())
                self.assertTrue(client.about_check.instate(['!disabled']))
            finally:
                root.destroy()

    def test_queue_reuses_worker_and_runs_callbacks_on_ui_thread(self):
        with tempfile.TemporaryDirectory(prefix='lan-drive-client-queue-') as directory:
            root = tk.Tk()
            root.withdraw()
            client = Client(root, Path(directory))
            workers = []
            callbacks = []

            def record(worker):
                workers.append(worker)
                callbacks.append(current_thread())
                if len(workers) == 1:
                    client.run(current_thread, record)
                else:
                    root.quit()

            timeout = root.after(5000, root.quit)
            try:
                client.run(current_thread, record)
                root.mainloop()
                self.assertEqual(callbacks, [current_thread(), current_thread()])
                self.assertIs(workers[0], workers[1])
            finally:
                root.after_cancel(timeout)
                root.destroy()

    def test_file_transfer_survives_pause_and_local_queue_reload(self):
        self.assertIsNotNone(DriveAPI, 'Windows 客户端模块尚未实现')
        with tempfile.TemporaryDirectory(prefix='lan-drive-client-check-') as directory:
            root = Path(directory)
            password = 'Client!Test2026'
            release_dir = root / 'release'
            release_dir.mkdir()
            bundle = b'lan drive test release'
            (release_dir / 'LanDrive.exe').write_bytes(bundle)
            (release_dir / 'windows.json').write_text(json.dumps({
                'version': '1.12.0', 'size': len(bundle), 'sha256': hashlib.sha256(bundle).hexdigest(),
            }), encoding='utf-8')
            environment = dict(os.environ, LAN_DRIVE_TEST_DATA=str(root / 'server'), LAN_DRIVE_TEST_RELEASE=str(release_dir),
                               LAN_DRIVE_TEST_PASSWORD=password)
            script = """
                import { createDrive } from './server/index.mjs';
                const { server } = createDrive({ dataDir: process.env.LAN_DRIVE_TEST_DATA,
                    releaseDir: process.env.LAN_DRIVE_TEST_RELEASE, initialPassword: process.env.LAN_DRIVE_TEST_PASSWORD });
                server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
            """
            with subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', '--experimental-sqlite', '--input-type=module', '-e', script],
                                  env=environment, stdout=subprocess.PIPE, text=True, encoding='utf-8') as server:
                try:
                    origin = server.stdout.readline().strip()
                    self.assertTrue(origin.startswith('http://127.0.0.1:'), origin)
                    api = DriveAPI(origin)
                    admin = api.login('admin', password)
                    source = root / '客户端测试.txt'
                    contents = b'first-block' * 850_000
                    source.write_bytes(contents)
                    device = uuid4().hex
                    job = api.start_upload(source, None, [], device)
                    job['source'] = str(source)
                    job['sourceMtime'] = source.stat().st_mtime_ns
                    job = step_upload(api, job)
                    self.assertTrue(0 < job['done'] < job['total'])
                    job.update(api.control('pause', job['id']))
                    local_queue = root / 'jobs.json'
                    persist(local_queue, [job])
                    job = load_jobs(local_queue)[0]
                    self.assertEqual(job['status'], 'paused')
                    job.update(api.control('resume', job['id']))
                    while job['status'] != 'success':
                        job = step_upload(api, job)
                    listed = api.request('/fs/list')['list']
                    self.assertEqual(listed[0]['name'], source.name)

                    downloaded = root / '下载副本.txt'
                    job = api.request('/task/download/start', method='POST', body={'fileId': [listed[0]['id']], 'device': device})
                    job['target'] = str(downloaded)
                    job = step_download(api, job)
                    self.assertTrue(0 < job['done'] < job['total'])
                    job.update(api.control('pause', job['id']))
                    persist(local_queue, [job])
                    job = load_jobs(local_queue)[0]
                    self.assertFalse(downloaded.exists())
                    job.update(api.control('resume', job['id']))
                    while job['status'] != 'success':
                        job = step_download(api, job)
                    self.assertEqual(downloaded.read_bytes(), contents)
                    self.assertEqual(api.request('/task/history', query={'type': 'download'})['list'][0]['id'], job['id'])
                    self.assertEqual(api.request('/task/history', query={'type': 'upload'})['list'][0]['name'], source.name)

                    public_root = api.request('/fs/list', query={'space': 'public'})['folder']['id']
                    api.request('/fs/copy', method='POST', body={'fileId': listed[0]['id'], 'targetParentId': public_root})
                    api.request('/admin/user/add', method='POST', body={'username': 'reader', 'nickname': '普通用户', 'pwd': password})
                    allowed = api.request('/admin/user/add', method='POST', body={'username': 'allowed', 'nickname': '已授权用户', 'pwd': password})
                    download_policy = '/fs/public/download-policy'
                    upload_policy = '/fs/public/upload-policy'
                    api.request(download_policy, method='PUT', body={'mode': 'selected', 'userIds': [allowed['id']]})
                    member_api = DriveAPI(origin)
                    member = member_api.login('reader', password)
                    window = tk.Tk()
                    window.withdraw()
                    try:
                        client = Client(window, root / 'desktop')
                        client.api = api
                        client.queue_file = root / 'desktop' / 'queue.json'
                        client.downloads[job['id']] = job
                        client.workspace(admin)
                        history = client.history['download']
                        client.notebook.select(history['frame'])
                        client.load_history('download')
                        deadline = monotonic() + 5
                        while not history['records'] and monotonic() < deadline:
                            window.update()
                            sleep(0.02)
                        self.assertIn(job['id'], history['records'], history['note'].get())
                        self.assertEqual(history['grid'].item(job['id'], 'values')[2], '已完成')
                        history['grid'].selection_set(job['id'])
                        window.update()
                        self.assertTrue(history['location'].instate(['!disabled']))
                        with patch('client.drive.messagebox.askyesno', return_value=True):
                            history['remove'].invoke()
                        deadline = monotonic() + 5
                        while history['busy'] and monotonic() < deadline:
                            window.update()
                            sleep(0.02)
                        self.assertEqual(history['records'], {})
                        self.assertEqual(downloaded.read_bytes(), contents)

                        release = api.request('/client/windows/release')
                        target = root / '更新下载.exe'
                        target.write_bytes(b'previous release')
                        with self.assertRaisesRegex(APIError, '校验'):
                            api.download_release({**release, 'sha256': '0' * 64}, target)
                        self.assertEqual(target.read_bytes(), b'previous release')
                        self.assertEqual(list(root.glob('.lan-drive-update-*.part')), [])
                        api.download_release(release, target)
                        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), release['sha256'])
                        self.assertEqual(target.stat().st_size, release['size'])

                        client.api = member_api
                        client.downloads.clear()
                        client.workspace(member)
                        client.location.current(1)
                        client.open_space()
                        def wait_for_files():
                            deadline = monotonic() + 5
                            while client.file_note.get() == '正在读取文件…' and monotonic() < deadline:
                                window.update()
                                sleep(0.02)
                            self.assertTrue(client.file_note.get().startswith('共 '), client.file_note.get())

                        wait_for_files()
                        self.assertEqual(client.location.get(), '公共网盘')
                        self.assertEqual(client.folder_id, public_root)
                        self.assertEqual([entry['name'] for entry in client.files.values()], [source.name])
                        self.assertTrue(all(button.instate(['disabled']) for button in client.upload_buttons))
                        download = next(button for button in client.upload_buttons[0].master.winfo_children()
                                        if button.cget('text') == '下载选中')
                        self.assertTrue(download.instate(['disabled']))
                        self.assertIn('下载需管理员授权', client.breadcrumb.cget('text'))
                        self.assertIn('上传需管理员授权', client.breadcrumb.cget('text'))

                        row, = client.file_grid.get_children()
                        client.file_grid.selection_set(row)
                        api.request(upload_policy, method='PUT', body={'mode': 'selected', 'userIds': [member['id']]})
                        client.refresh()
                        wait_for_files()
                        self.assertEqual(client.file_grid.selection(), (row,))
                        self.assertTrue(all(button.instate(['!disabled']) for button in client.upload_buttons))
                        self.assertTrue(download.instate(['disabled']))
                        self.assertNotIn('上传需管理员授权', client.breadcrumb.cget('text'))

                        api.request(upload_policy, method='PUT', body={'mode': 'admin'})
                        api.request(download_policy, method='PUT', body={'mode': 'selected', 'userIds': [member['id']]})
                        client.refresh()
                        wait_for_files()
                        self.assertTrue(all(button.instate(['disabled']) for button in client.upload_buttons))
                        self.assertFalse(download.instate(['disabled']))
                        self.assertNotIn('下载需管理员授权', client.breadcrumb.cget('text'))
                    finally:
                        window.destroy()
                finally:
                    server.terminate()
                    server.wait(timeout=15)


if __name__ == '__main__':
    unittest.main()
