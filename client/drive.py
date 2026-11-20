import hashlib
import http.client
import json
import os
from collections import deque
from pathlib import Path
from queue import Empty, Queue
import re
import subprocess
import sys
from tempfile import NamedTemporaryFile
from threading import Thread
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4
import webbrowser

TASK_STATES = {'waiting': '等待中', 'preparing': '正在打包', 'transferring': '传输中', 'paused': '已暂停',
               'success': '已完成', 'failed': '失败', 'cancelled': '已取消'}
FINISHED = ('success', 'cancelled')
RUNNABLE = ('waiting', 'preparing', 'transferring')
HISTORY_SIZE = 30
FILE_PAGE_SIZE = 100
CLIENT_VERSION = '1.2.0'
PROJECT_URL = 'https://github.com/limingnanyue/lan-private-drive'


class APIError(Exception):
    def __init__(self, message, status=0, code=0, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def release_version(release):
    if not isinstance(release, dict):
        raise APIError('服务器返回的版本信息无效')
    version, size, checksum = (release.get(key) for key in ('version', 'size', 'sha256'))
    if (not isinstance(version, str) or not re.fullmatch(r'[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}', version)
            or type(size) is not int or size <= 0
            or not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum)):
        raise APIError('服务器返回的版本信息无效')
    return tuple(map(int, version.split('.')))


class DriveAPI:
    def __init__(self, origin):
        origin = origin.strip().rstrip('/')
        if '://' not in origin:
            origin = 'http://' + origin
        address = urlsplit(origin)
        if address.scheme not in ('http', 'https') or not address.hostname or address.username is not None or address.path or address.query or address.fragment:
            raise ValueError('请输入网盘首页地址，例如 http://192.168.1.10:8080')
        try:
            address.port
        except ValueError as error:
            raise ValueError('端口号无效') from error
        self.origin = f'{address.scheme}://{address.netloc}'
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.token = ''

    def request(self, path, *, method='GET', query=None, body=None, headers=None, raw=False, timeout=120):
        address = f'{self.origin}/api/v1{path}'
        if query:
            address += '?' + urlencode({key: value for key, value in query.items() if value is not None})
        headers = dict(headers or {})
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if isinstance(body, dict):
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        try:
            with self.opener.open(Request(address, body, headers, method=method), timeout=timeout) as response:
                data = response.read()
        except HTTPError as error:
            try:
                data = json.loads(error.read())
            except (ValueError, OSError):
                data = {}
            raise APIError(data.get('msg', f'网盘请求失败（{error.code}）'), error.code, data.get('code', 0), data.get('data')) from error
        except (URLError, OSError, http.client.HTTPException) as error:
            raise APIError('连接不到内网网盘服务') from error
        if raw:
            return data
        try:
            decoded = json.loads(data)
        except ValueError as error:
            raise APIError('该地址返回了无法识别的网盘响应', 502) from error
        if decoded.get('code') != 0:
            raise APIError(decoded.get('msg', '网盘请求失败'), 400, decoded.get('code', 0))
        return decoded['data']

    def login(self, name, password):
        self.token = ''
        login = self.request('/auth/login', method='POST', body={'username': name, 'password': password})
        self.token = login['token']
        return login['userInfo']

    def control(self, action, task_id, **fields):
        return self.request('/task/' + action, method='DELETE' if action == 'cancel' else 'PUT', body={'taskId': task_id, **fields})

    def start_upload(self, source, parent, parents, device, conflict=None):
        stat = source.stat()
        key = hashlib.sha256(f'{source}\n{stat.st_size}\n{stat.st_mtime_ns}'.encode()).hexdigest()
        return self.request('/task/upload/start', method='POST', body={'name': source.name, 'total': stat.st_size,
                            'parentId': parent, 'parents': parents, 'device': device, 'clientKey': key, 'conflict': conflict})

    def chunk(self, job, offset, payload):
        boundary = uuid4().hex
        fields = {'taskId': job, 'offset': str(offset), 'sha256': hashlib.sha256(payload).hexdigest()}
        prefix = ''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n' for key, value in fields.items())
        part = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.dat"\r\nContent-Type: application/octet-stream\r\n\r\n'
        return self.request('/fs/upload', method='POST', body=b''.join(((prefix + part).encode(), payload, f'\r\n--{boundary}--\r\n'.encode())),
                            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})

    def download_release(self, release, target, progress=None):
        version, expected, checksum = release['version'], release['size'], release['sha256']
        address = f'{self.origin}/client/windows?' + urlencode({'version': version})
        request = Request(address, headers={'Authorization': 'Bearer ' + self.token})
        for attempt in range(3):
            if progress is not None:
                progress(0, expected)
            try:
                return self._receive_release(request, target, expected, checksum, progress)
            except APIError as error:
                if attempt == 2 or error.status not in (0, 408, 429, 500, 502, 503, 504):
                    raise
                time.sleep(attempt + 1)

    def _receive_release(self, request, target, expected, checksum, progress):
        temp = None
        try:
            with self.opener.open(request, timeout=30) as response:
                digest = hashlib.sha256()
                received = 0
                with NamedTemporaryFile(dir=target.parent, prefix='.lan-drive-update-', suffix='.part', delete=False) as file:
                    temp = Path(file.name)
                    for block in iter(lambda: response.read(256 * 1024), b''):
                        received += len(block)
                        if received > expected:
                            raise APIError('更新包大小校验失败，请重新检查更新', 422)
                        digest.update(block)
                        file.write(block)
                        if progress is not None:
                            progress(received, expected)
                    if received != expected:
                        raise APIError('更新包下载不完整，请重试', 502)
                    if digest.hexdigest() != checksum:
                        raise APIError('更新包校验失败，请重新检查更新', 422)
                    file.flush()
                    os.fsync(file.fileno())
                temp.replace(target)
        except HTTPError as error:
            error.close()
            hint = {401: '登录会话已过期，请重新登录', 409: '服务器已发布新版本，请重新检查更新'}
            raise APIError(hint.get(error.code, f'无法下载更新包（{error.code}）'), error.code) from error
        except (URLError, TimeoutError, ConnectionError, http.client.HTTPException) as error:
            raise APIError('更新下载中断，请重试') from error
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)
        return target


def persist(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    replacement = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        with replacement.open('x', encoding='utf-8') as file:
            json.dump(data, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
        replacement.replace(path)
    finally:
        replacement.unlink(missing_ok=True)


def load_jobs(path):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else []


def step_upload(api, job):
    source = Path(job['source'])
    stat = source.stat()
    if stat.st_size != job['total'] or stat.st_mtime_ns != job['sourceMtime']:
        raise ValueError('本地源文件已修改，请取消任务后重新上传')
    if job['done'] < job['total']:
        with source.open('rb') as reader:
            reader.seek(job['done'])
            payload = reader.read(job['chunkSize'])
        if not payload:
            raise ValueError('本地源文件已损坏或被删除')
        return {**job, **api.chunk(job['id'], job['done'], payload)}
    result = api.request('/fs/upload/merge', method='POST', body={'fileKey': job['id'], 'conflict': job.get('resolution')})
    return {**job, **result['task']}


def partial_path(job):
    target = Path(job['target'])
    return target.with_name(f'.lan-drive-{job["id"]}.part')


def step_download(api, job):
    target = Path(job['target'])
    part = partial_path(job)
    if job['status'] == 'success' and target.exists() and not part.exists():
        return job
    offset = part.stat().st_size if part.exists() else 0
    total = job['total']
    if offset > total:
        raise ValueError('本地下载断点与服务端文件大小不匹配，请重新下载')
    if offset < total or (total == 0 and not part.exists()):
        end = min(total, offset + job['chunkSize']) - 1
        headers = {'Range': f'bytes={offset}-{end}'} if total else {}
        data = api.request('/task/download/data', query={'taskId': job['id']}, headers=headers, raw=True)
        if len(data) != end - offset + 1:
            raise ValueError('下载分片校验失败')
        with part.open('r+b' if part.exists() else 'xb') as writer:
            writer.seek(offset)
            writer.write(data)
            writer.flush()
            os.fsync(writer.fileno())
        offset += len(data)
    if offset == total and target.exists() and not job.get('overwriteTarget'):
        raise ValueError('下载位置出现了同名文件，请移动现有文件后继续')
    updated = api.control('progress', job['id'], done=offset)
    if offset == total:
        part.replace(target)
    return {**job, **updated}


def display_size(value):
    amount = float(value)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if amount < 1024 or unit == 'TB':
            return f'{amount:.1f} {unit}' if unit != 'B' else f'{value} B'
        amount /= 1024


class Client:
    def __init__(self, root, local):
        self.root = root
        self.local = local
        self.api = None
        self.jobs = {}
        self.downloads = {}
        self.files = {}
        self.work = Queue()
        self.result = Queue()
        self.update_result = Queue()
        self.updating = False
        self.pending = False
        self.device = uuid4().hex
        self.retry_at = {}
        self.action_pending = deque()
        self.package_poll = 0
        self.status = tk.StringVar(value='请输入局域网内的网盘地址。')
        self.about_window = None
        self.update_note = tk.StringVar()
        self.update_percent = tk.DoubleVar()
        self.connected_server = tk.StringVar()
        root.title('局域网私有网盘 · Windows 客户端')
        root.geometry('1080x680')
        root.minsize(740, 485)
        root.protocol('WM_DELETE_WINDOW', self.minimize)
        root.bind('<Destroy>', self.stop_worker, add=True)
        style = ttk.Style(root)
        style.theme_use('clam')
        root.configure(background='#f4f7fb')
        style.configure('.', font=('Microsoft YaHei UI', 10), foreground='#19304e', background='#f4f7fb')
        style.configure('Title.TLabel', font=('Microsoft YaHei UI', 22, 'bold'))
        style.configure('Detail.TLabel', foreground='#465e78')
        style.configure('Card.TFrame', background='#ffffff', bordercolor='#d2dfed', lightcolor='#d2dfed', darkcolor='#d2dfed')
        style.configure('Card.TLabel', background='#ffffff')
        style.configure('Card.Title.TLabel', background='#ffffff')
        style.configure('Card.Detail.TLabel', background='#ffffff')
        style.configure('TEntry', padding=(10, 7), fieldbackground='#ffffff', bordercolor='#b7cae0')
        style.configure('TCombobox', padding=(8, 5), bordercolor='#b7cae0')
        style.map('TCombobox', fieldbackground=[('readonly', 'focus', '#2462b9'), ('readonly', '#ffffff')])
        style.configure('TNotebook', bordercolor='#ccd8e8', tabmargins=(0, 0, 0, 0))
        style.configure('TNotebook.Tab', padding=(19, 9), background='#e6eef8')
        style.map('TNotebook.Tab', padding=[('selected', '19 9')],
                  background=[('selected', '#ffffff'), ('active', '#d7e8fb')],
                  foreground=[('selected', '#194b9a')])
        style.configure('TButton', padding=(10, 5), bordercolor='#c2d2e8', background='#ffffff', focuscolor='#2858aa')
        style.map('TButton', background=[('disabled', '#edf2f8'), ('pressed', '#d2e4ff'), ('active', '#e3efff')])
        style.configure('Primary.TButton', background='#245dcc', foreground='#ffffff', bordercolor='#245dcc', focuscolor='#cbe0ff')
        style.map('Primary.TButton', foreground=[('disabled', '#54667e')],
                  background=[('disabled', '#e2eaf5'), ('pressed', '#164598'), ('active', '#1c50b4')])
        style.configure('Danger.TButton', foreground='#9b253a')
        style.map('Danger.TButton', foreground=[('disabled', '#66778b')], background=[('disabled', '#edf2f8'), ('active', '#fdeef0')])
        style.configure('Treeview', rowheight=max(34, round(25 * float(root.tk.call('tk', 'scaling')))),
                        background='#ffffff', fieldbackground='#ffffff', bordercolor='#cfdced')
        style.configure('Treeview.Heading', background='#e6eef8', foreground='#314b6c', padding=(10, 8), relief='flat')
        style.map('Treeview', background=[('selected', '#2462b9')], foreground=[('selected', '#ffffff')])
        style.configure('Footer.TFrame', background='#e9f0f8')
        style.configure('Footer.TLabel', background='#e9f0f8', foreground='#36506e')
        style.configure('Horizontal.TProgressbar', background='#245dcc', troughcolor='#e0e8f4')
        footer = ttk.Frame(root, style='Footer.TFrame')
        footer.pack(fill='x', side='bottom')
        ttk.Button(footer, text='关于', command=self.about).pack(side='right', padx=(0, 14), pady=5)
        ttk.Label(footer, text=f'v{CLIENT_VERSION}', style='Footer.TLabel', padding=(10, 8)).pack(side='right')
        ttk.Label(footer, textvariable=self.status, style='Footer.TLabel', padding=(20, 8), anchor='w').pack(side='left', fill='x', expand=True)
        self.content = ttk.Frame(root, padding=(22, 18))
        self.content.pack(fill='both', expand=True)
        self.login_screen()
        Thread(target=self.worker, daemon=True).start()
        self.poll_timer = self.root.after(120, self.poll)

    def login_screen(self):
        self.clear_content()
        self.update_connection()
        last = self.local / 'address.txt'
        self.address = tk.StringVar(value=last.read_text(encoding='utf-8') if last.exists() else 'http://127.0.0.1:8080')
        self.username = tk.StringVar(value='admin')
        self.password = tk.StringVar()
        form = ttk.Frame(self.content, style='Card.TFrame', padding=(32, 28), relief='solid', borderwidth=1)
        form.pack(expand=True)
        ttk.Label(form, text='局域网私有网盘', style='Card.Title.TLabel').grid(row=0, column=0, columnspan=2, sticky='w')
        ttk.Label(form, text='连接服务器', style='Card.Detail.TLabel').grid(row=1, column=0, columnspan=2, pady=(4, 19), sticky='w')
        for index, (label, value) in enumerate((('网盘地址', self.address), ('账号', self.username), ('密码', self.password)), 2):
            ttk.Label(form, text=label, style='Card.TLabel').grid(row=index, column=0, pady=7, padx=(0, 16), sticky='w')
            field = ttk.Entry(form, textvariable=value, width=34, show='●' if index == 4 else '')
            field.grid(row=index, column=1, pady=7, sticky='ew')
            field.bind('<Return>', lambda event: self.login())
        self.login_button = ttk.Button(form, text='登录', command=self.login, style='Primary.TButton')
        self.login_button.grid(row=5, column=1, sticky='ew', pady=(13, 0))
        field.focus_set()

    def login(self):
        if self.pending:
            return
        try:
            api = DriveAPI(self.address.get())
        except ValueError as error:
            self.status.set(str(error))
            return
        username, password = self.username.get(), self.password.get()
        self.login_button.state(['disabled'])
        self.status.set('正在登录…')

        def connect():
            user = api.login(username, password)
            key = hashlib.sha256(f'{api.origin}/{user["id"]}/{user["username"]}'.encode()).hexdigest()[:28]
            local = self.local / f'{key}.json'
            jobs, downloads = {}, {}
            remote = {job['id']: job for job in api.request('/task/list', query={'active': 1})['list']}
            oldest = (time.time() - 30 * 86400) * 1000
            for job in load_jobs(local):
                latest = remote.get(job['id'])
                if latest is None and job['status'] not in FINISHED:
                    try:
                        latest = api.request('/task/info', query={'taskId': job['id']})
                    except APIError as error:
                        if error.status != 404:
                            raise
                        job.update(status='failed', reason='服务端任务已取消或已到期')
                if latest:
                    job.update(latest)
                if job['status'] == 'success' and job.get('target'):
                    if partial_path(job).exists():
                        job['status'] = 'waiting'
                    elif job.get('updatedAt', oldest) >= oldest:
                        downloads[job['id']] = job
                if job['status'] not in FINISHED:
                    jobs[job['id']] = job
            return user, local, jobs, downloads

        def connected(result):
            user, self.queue_file, self.jobs, self.downloads = result
            self.api = api
            self.device = next((job['device'] for job in self.jobs.values() if job.get('device')), self.device)
            self.local.mkdir(parents=True, exist_ok=True)
            (self.local / 'address.txt').write_text(api.origin, encoding='utf-8')
            self.password.set('')
            self.status.set('已连接 · ' + api.origin)
            self.workspace(user)
            self.refresh()

        def failed(error):
            self.login_button.state(['!disabled'])
            self.status.set(str(error))

        self.run(connect, connected, failed)

    def clear_content(self):
        for widget in self.content.winfo_children():
            widget.destroy()

    def workspace(self, user):
        self.clear_content()
        self.space = None
        self.current = None
        self.chain = []
        self.file_page = 1
        self.file_request = 0
        self.file_view = None
        heading = ttk.Frame(self.content)
        heading.pack(fill='x', pady=(1, 12))
        identity = ttk.Frame(heading)
        identity.pack(side='left', fill='x', expand=True)
        ttk.Label(identity, text='局域网私有网盘', style='Title.TLabel').pack(anchor='w')
        ttk.Label(identity, text=f'{user["name"]}  ·  {self.api.origin}', style='Detail.TLabel').pack(anchor='w', pady=(3, 0))
        ttk.Button(heading, text='退出客户端', command=self.exit).pack(side='right')
        self.update_button = ttk.Button(heading, text='检查更新', command=self.check_update, state='disabled' if self.updating else 'normal')
        self.update_button.pack(side='right', padx=(0, 7))
        notebook = self.notebook = ttk.Notebook(self.content)
        notebook.pack(fill='both', expand=True)
        files = ttk.Frame(notebook, padding=12)
        transfers = ttk.Frame(notebook, padding=12)
        notebook.add(files, text='网盘文件')
        notebook.add(transfers, text='传输队列')
        location_bar = ttk.Frame(files)
        location_bar.pack(fill='x', pady=(0, 10))
        self.location = ttk.Combobox(location_bar, values=('我的文件', '公共网盘'), width=11, state='readonly')
        self.location.current(0)
        self.location.pack(side='left', padx=(0, 12))
        self.location.bind('<<ComboboxSelected>>', self.open_space)
        self.breadcrumb = ttk.Label(location_bar, anchor='w', style='Detail.TLabel')
        self.breadcrumb.pack(side='left', fill='x', expand=True)
        file_toolbar = ttk.Frame(files)
        file_toolbar.pack(fill='x', pady=(0, 10))
        for label, callback in (('返回', self.up), ('刷新', self.refresh)):
            ttk.Button(file_toolbar, text=label, command=callback).pack(side='left', padx=(0, 5))
        self.upload_buttons = [ttk.Button(file_toolbar, text=label, command=callback, state='disabled')
                               for label, callback in (('上传文件', self.upload_files), ('上传文件夹', self.upload_folder))]
        self.upload_buttons[0].configure(style='Primary.TButton')
        for control in self.upload_buttons:
            control.pack(side='left', padx=(0, 5))
        self.download_button = ttk.Button(file_toolbar, text='下载选中', command=self.download_files, state='disabled')
        self.download_button.pack(side='right')
        file_pager = ttk.Frame(files)
        file_pager.pack(side='bottom', fill='x', pady=(8, 0))
        self.file_previous = ttk.Button(file_pager, text='上一页', state='disabled', command=lambda: self.refresh(-1))
        self.file_following = ttk.Button(file_pager, text='下一页', state='disabled', command=lambda: self.refresh(1))
        self.file_following.pack(side='right')
        self.file_previous.pack(side='right', padx=(0, 7))
        self.file_note = tk.StringVar()
        ttk.Label(file_pager, textvariable=self.file_note, style='Detail.TLabel').pack(side='left')
        self.file_grid = self.table(files, ('名称', '类型', '大小'), (440, 115, 115))
        self.file_grid.bind('<Double-1>', self.enter_folder)
        self.file_grid.bind('<Return>', self.enter_folder)
        task_toolbar = ttk.Frame(transfers)
        task_toolbar.pack(fill='x', pady=(0, 8))
        for label, callback in (('暂停', lambda: self.control('pause')), ('继续', lambda: self.control('resume')), ('取消', lambda: self.control('cancel')), ('打开下载位置', self.open_download)):
            ttk.Button(task_toolbar, text=label, command=callback).pack(side='left', padx=(0, 5))
        self.task_grid = self.table(transfers, ('文件名', '方向', '进度', '状态'), (320, 65, 150, 150))
        for job in self.jobs.values():
            self.paint_task(job)
        self.history = {}
        for kind, label in (('upload', '上传记录'), ('download', '下载记录')):
            self.history_tab(kind, label)
        notebook.enable_traversal()
        notebook.bind('<<NotebookTabChanged>>', self.history_changed)
        self.update_connection()

    @staticmethod
    def table(parent, columns, widths):
        group = ttk.Frame(parent)
        group.pack(fill='both', expand=True)
        grid = ttk.Treeview(group, columns=columns, show='headings')
        scrollbar = ttk.Scrollbar(group, orient='vertical', command=grid.yview)
        grid.configure(yscrollcommand=scrollbar.set)
        for index, (column, width) in enumerate(zip(columns, widths)):
            anchor = 'w' if index == 0 else 'center'
            grid.heading(column, text=column, anchor=anchor)
            grid.column(column, width=width, stretch=index == 0, anchor=anchor)
        scrollbar.pack(side='right', fill='y')
        grid.pack(side='left', fill='both', expand=True)
        grid.tag_configure('alternate', background='#f1f6fd')
        grid.tag_configure('success', foreground='#146141')
        grid.tag_configure('failed', foreground='#9b253a')
        return grid

    def history_tab(self, kind, label):
        frame = ttk.Frame(self.notebook, padding=12)
        self.notebook.add(frame, text=label)
        toolbar = ttk.Frame(frame)
        toolbar.pack(fill='x', pady=(0, 8))
        refresh = ttk.Button(toolbar, text='刷新记录', command=lambda: self.load_history(kind))
        refresh.pack(side='left')
        remove = ttk.Button(toolbar, text='删除选中', style='Danger.TButton', state='disabled', command=lambda: self.clean_history(kind))
        remove.pack(side='left', padx=(7, 0))
        clear = ttk.Button(toolbar, text='清空记录', style='Danger.TButton', state='disabled', command=lambda: self.clean_history(kind, True))
        clear.pack(side='left', padx=(7, 0))
        note = tk.StringVar(value='')
        ttk.Label(toolbar, textvariable=note, style='Detail.TLabel').pack(side='left', padx=10)
        pager = ttk.Frame(frame)
        pager.pack(side='bottom', fill='x', pady=(8, 0))
        previous = ttk.Button(pager, text='上一页', state='disabled', command=lambda: self.load_history(kind, -1))
        following = ttk.Button(pager, text='下一页', state='disabled', command=lambda: self.load_history(kind, 1))
        following.pack(side='right')
        previous.pack(side='right', padx=(0, 6))
        detail = tk.StringVar()
        ttk.Label(pager, textvariable=detail, style='Detail.TLabel', wraplength=460).pack(side='left', fill='x', expand=True)
        grid = self.table(frame, ('文件名', '大小', '状态', '更新时间', '备注'), (220, 76, 83, 152, 126))
        location = None
        if kind == 'download':
            location = ttk.Button(toolbar, text='打开下载位置', state='disabled', command=lambda: self.open_download(grid))
            location.pack(side='right')
        state = {'frame': frame, 'grid': grid, 'note': note, 'detail': detail, 'page': 1, 'busy': False, 'total': 0,
                 'previous': previous, 'following': following, 'location': location, 'records': {},
                 'refresh': refresh, 'remove': remove, 'clear': clear, 'label': label}
        self.history[kind] = state
        grid.bind('<<TreeviewSelect>>', lambda event: self.history_selection(state))

    def history_selection(self, state):
        selected = state['grid'].selection()
        record = state['records'].get(selected[0]) if selected else None
        state['detail'].set((record.get('reason') or '') if record else '')
        available = not state['busy']
        for key, enabled in (('refresh', available), ('remove', available and selected), ('clear', available and state['total']),
                             ('previous', available and state['page'] > 1),
                             ('following', available and state['page'] * HISTORY_SIZE < state['total'])):
            state[key].state(['!disabled' if enabled else 'disabled'])
        if state['location'] is not None:
            local = self.downloads.get(selected[0]) if selected else None
            state['location'].state(['!disabled'] if local and local.get('target') else ['disabled'])

    def history_changed(self, event=None):
        for kind, state in self.history.items():
            if self.notebook.select() == str(state['frame']):
                self.load_history(kind)
                break

    def load_history(self, kind, delta=0):
        state = self.history[kind]
        if state['busy']:
            return
        page = max(1, state['page'] + delta)
        api = self.api
        state['busy'] = True
        state['note'].set('正在读取记录…')
        self.history_selection(state)

        def draw(data):
            if not state['frame'].winfo_exists():
                return
            state['busy'] = False
            state['total'] = data['total']
            pages = max(1, (data['total'] + HISTORY_SIZE - 1) // HISTORY_SIZE)
            state['page'] = min(page, pages)
            if page > pages:
                self.load_history(kind)
                return
            state['records'] = {entry['id']: entry for entry in data['list']}
            grid = state['grid']
            grid.delete(*grid.get_children())
            for index, entry in enumerate(data['list']):
                updated = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(entry['updatedAt'] / 1000))
                tags = (entry['status'], 'alternate') if index % 2 else (entry['status'],)
                grid.insert('', 'end', iid=entry['id'], values=(entry['name'], display_size(entry['total']),
                            TASK_STATES[entry['status']], updated, entry.get('reason') or '—'), tags=tags)
            state['note'].set(f'共 {data["total"]} 条 · 第 {page} / {pages} 页' if data['total'] else '暂无记录')
            self.history_selection(state)

        def failed(error):
            state['busy'] = False
            if state['frame'].winfo_exists():
                state['note'].set(str(error))
                self.history_selection(state)

        self.dispatch(lambda: api.request('/task/history', query={'type': kind, 'page': page, 'size': HISTORY_SIZE}), draw, failed)

    def clean_history(self, kind, clear_all=False):
        state = self.history[kind]
        selected = list(state['grid'].selection())
        if state['busy'] or not (state['total'] if clear_all else selected):
            return
        label = state['label'] if clear_all else f'{len(selected)} 条选中记录'
        state['busy'] = True
        self.history_selection(state)
        if not messagebox.askyesno('清理传输记录', f'清理{label}？文件和传输断点会保留。', parent=self.root):
            state['busy'] = False
            self.history_selection(state)
            return
        api = self.api
        state['note'].set('正在清理记录…')
        body = {'clear': True} if clear_all else {'taskIds': selected}

        def done(result):
            state['busy'] = False
            if not state['frame'].winfo_exists():
                return
            if kind == 'download' and result['deleted']:
                if clear_all:
                    self.downloads.clear()
                else:
                    for key in selected:
                        self.downloads.pop(key, None)
                try:
                    persist(self.queue_file, [*self.jobs.values(), *self.downloads.values()])
                except OSError as error:
                    self.status.set(f'服务端记录已清理，本地状态保存失败。{error}')
                else:
                    self.status.set(f'已清理 {result["deleted"]} 条记录')
            else:
                self.status.set(f'已清理 {result["deleted"]} 条记录')
            if clear_all:
                state['page'] = 1
            self.load_history(kind)

        def failed(error):
            state['busy'] = False
            if state['frame'].winfo_exists():
                state['note'].set(str(error))
                self.history_selection(state)

        self.dispatch(lambda: api.request('/task/history', method='DELETE', query={'type': kind}, body=body), done, failed)

    def about(self):
        if self.about_window is not None:
            self.about_window.deiconify()
            self.about_window.lift()
            return
        window = self.about_window = tk.Toplevel(self.root)
        window.title(f'关于局域网私有网盘 · v{CLIENT_VERSION}')
        window.transient(self.root)
        window.resizable(False, False)
        window.protocol('WM_DELETE_WINDOW', window.withdraw)
        window.bind('<Escape>', lambda event: window.withdraw())
        content = ttk.Frame(window, padding=(24, 20))
        content.pack(fill='both', expand=True)
        ttk.Label(content, text='局域网私有网盘', style='Title.TLabel').pack(anchor='w')
        ttk.Label(content, text=f'Windows 客户端  ·  v{CLIENT_VERSION}', style='Detail.TLabel').pack(anchor='w', pady=(2, 3))
        ttk.Label(content, textvariable=self.connected_server, style='Detail.TLabel', wraplength=420).pack(anchor='w')
        ttk.Separator(content).pack(fill='x', pady=(17, 13))
        ttk.Label(content, text='客户端更新', font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w')
        ttk.Label(content, textvariable=self.update_note, wraplength=420, width=49).pack(anchor='w', pady=(6, 10))
        self.update_bar = ttk.Progressbar(content, variable=self.update_percent, mode='determinate')
        controls = ttk.Frame(content)
        controls.pack(fill='x')
        ttk.Button(controls, text='开源项目', command=lambda: webbrowser.open(PROJECT_URL)).pack(side='left')
        self.about_check = ttk.Button(controls, text='检查更新', command=self.check_update)
        self.about_check.pack(side='left', padx=(8, 0))
        self.update_action = ttk.Button(controls, text='下载新版…', style='Primary.TButton', state='disabled')
        self.update_action.pack(side='right')
        self.update_state(self.update_note.get(), self.updating)

    def update_connection(self):
        message = '更新来自当前连接的网盘服务器。' if self.api else '登录网盘后可检查更新。'
        self.connected_server.set(self.api.origin if self.api else '尚未连接网盘')
        if self.about_window is not None:
            self.update_action.state(['disabled'])
            self.update_bar.pack_forget()
        self.update_percent.set(0)
        self.update_state(message, self.updating)

    def update_state(self, message, busy=False):
        self.updating = busy
        self.update_note.set(message)
        state = ['!disabled' if self.api and not busy else 'disabled']
        for button in (getattr(self, 'update_button', None), getattr(self, 'about_check', None)):
            if button is not None and button.winfo_exists():
                button.state(state)

    def check_update(self):
        self.about()
        api = self.api
        if not api or self.updating:
            return
        self.update_action.configure(text='下载新版…', state='disabled')
        self.update_bar.pack_forget()
        self.update_percent.set(0)
        self.update_state('正在检查更新…', busy=True)

        def check():
            release = api.request('/client/windows/release', timeout=8)
            available = release_version(release)
            current = tuple(map(int, CLIENT_VERSION.split('.')))
            return release if available > current else None

        def checked(release):
            if api is not self.api:
                self.update_state('网盘连接已变化，请重新检查。')
            elif release is None:
                self.update_state(f'当前版本 v{CLIENT_VERSION} 已是最新版本。')
            else:
                self.update_state(f'发现新版 v{release["version"]}（{display_size(release["size"])}）。')
                self.update_action.configure(command=lambda: self.save_update(api, release), state='normal')

        Thread(target=self.execute, args=(self.update_result, check, checked, lambda error: self.update_state(str(error))), daemon=True).start()

    def save_update(self, api, release):
        if self.updating or api is not self.api:
            return
        version = release['version']
        filename = filedialog.asksaveasfilename(title='保存新版程序', initialfile=f'LanDrive-{version}.exe', defaultextension='.exe',
                                                filetypes=[('Windows 应用程序', '*.exe')], confirmoverwrite=True, parent=self.about_window)
        if not filename:
            return
        target = Path(filename)
        if target.suffix.lower() != '.exe':
            self.update_state('请使用 .exe 扩展名保存新版。')
            return
        if getattr(sys, 'frozen', False) and (target.resolve() == Path(sys.executable).resolve()
                or (target.exists() and target.samefile(sys.executable))):
            self.update_state('请将新版保存到其他位置。')
            return
        self.update_action.state(['disabled'])
        self.update_percent.set(0)
        self.update_bar.pack(fill='x', pady=(0, 16), before=self.update_action.master)
        self.update_state(f'正在下载 v{version}…', busy=True)
        self.status.set(f'正在下载客户端 v{version}…')
        last_report = 0

        def show_progress(progress):
            received, total = progress
            self.update_percent.set(received * 100 / total)
            message = '正在校验更新包…' if received == total else f'正在下载 v{version} · {display_size(received)} / {display_size(total)}'
            self.update_note.set(message)

        def report(received, total):
            nonlocal last_report
            now = time.monotonic()
            if received in (0, total) or now - last_report >= 0.25:
                self.update_result.put((show_progress, (received, total)))
                last_report = now

        def downloaded(path):
            self.update_percent.set(100)
            self.update_state(f'v{version} 已校验并保存到 {path}')
            self.update_action.configure(text='运行新版', command=lambda: self.run_update(path), state='normal')
            self.status.set(f'客户端 v{version} 已下载，可在「关于」运行新版。')

        def failed(error):
            self.update_percent.set(0)
            self.update_bar.pack_forget()
            self.update_state(str(error))
            self.status.set('客户端下载更新失败，详情见「关于」。')
            if api is self.api and getattr(error, 'status', None) not in (401, 409, 422):
                self.update_action.configure(text='重试下载…', command=lambda: self.save_update(api, release), state='normal')

        Thread(target=self.execute, args=(self.update_result, lambda: api.download_release(release, target, report), downloaded, failed), daemon=True).start()

    def run_update(self, target):
        if self.pending or self.action_pending or any(job['status'] in RUNNABLE for job in self.jobs.values()):
            self.update_state('请等待当前传输完成或暂停队列，再运行新版。')
            return
        try:
            subprocess.Popen([str(target.resolve())], cwd=target.parent)
        except OSError as error:
            self.update_state(f'无法启动新版 · {error}')
        else:
            self.root.destroy()

    def dispatch(self, action, done, wrong=None):
        self.action_pending.append((action, done, wrong))

    def run(self, action, done, wrong=None):
        self.pending = True
        self.work.put((action, done, wrong))

    def worker(self):
        for action, done, wrong in iter(self.work.get, None):
            self.execute(self.result, action, done, wrong)

    def execute(self, result, action, done, wrong):
        try:
            result.put((done, action()))
        except Exception as error:
            result.put((wrong or (lambda error: self.status.set(str(error))), error))

    def stop_worker(self, event):
        if event.widget is self.root:
            self.root.after_cancel(self.poll_timer)
            self.work.put(None)

    def open_space(self, event=None):
        self.space = 'public' if self.location.current() == 1 else None
        self.current = None
        self.chain = []
        self.file_page = 1
        self.refresh()

    def refresh(self, delta=0):
        space = self.space
        parent = self.current
        page = max(1, self.file_page + delta)
        api, grid = self.api, self.file_grid
        self.file_request += 1
        serial = self.file_request
        view = (space, parent, page)
        if view != self.file_view:
            self.file_view = view
            self.files = {}
            grid.delete(*grid.get_children())
            self.breadcrumb.configure(text='')
        for control in self.upload_buttons:
            control.state(['disabled'])
        self.download_button.state(['disabled'])
        self.file_previous.state(['disabled'])
        self.file_following.state(['disabled'])
        self.file_note.set('正在读取文件…')

        def read():
            if serial == self.file_request:
                return api.request('/fs/list', query={'parentId': parent, 'space': space, 'page': page, 'size': FILE_PAGE_SIZE})

        def draw(data):
            if data is None or serial != self.file_request or not grid.winfo_exists():
                return
            folder = data['folder']
            if space == 'public' and (not folder or folder.get('ownerId') != 0):
                self.file_note.set('当前网盘服务尚不支持公共网盘')
                return
            pages = max(1, (data['total'] + FILE_PAGE_SIZE - 1) // FILE_PAGE_SIZE)
            self.file_page = min(page, pages)
            if page > pages:
                self.refresh()
                return
            self.folder_id = folder['id'] if folder else None
            self.chain = (folder['path'] if folder else [])[int(space == 'public'):]
            details = ['  ›  '.join(['根目录', *(item['name'] for item in self.chain)])]
            if data.get('canDownload', True):
                self.download_button.state(['!disabled'])
            else:
                details.append('下载需管理员授权')
            if data.get('canUpload', data['permission'] in ('owner', 'write')):
                for control in self.upload_buttons:
                    control.state(['!disabled'])
            elif space == 'public':
                details.append('上传需管理员授权')
            self.breadcrumb.configure(text='  ·  '.join(filter(None, details)))
            files = {str(item['id']): item for item in data['list']}
            if list(files.items()) != list(self.files.items()):
                selected = grid.selection()
                grid.delete(*grid.get_children())
                self.files = files
                for index, (key, item) in enumerate(files.items()):
                    is_folder = item['kind'] == 'folder'
                    grid.insert('', 'end', iid=key,
                                values=(item['name'], '文件夹' if is_folder else '文件', '—' if is_folder else display_size(item['size'])),
                                tags=('alternate',) if index % 2 else ())
                grid.selection_set([key for key in selected if key in files])
            self.file_note.set(f'共 {data["total"]} 项 · 第 {page} / {pages} 页' if data['total'] else '当前目录为空')
            self.file_previous.state(['!disabled'] if page > 1 else ['disabled'])
            self.file_following.state(['!disabled'] if page < pages else ['disabled'])

        def failed(error):
            if serial == self.file_request and grid.winfo_exists():
                self.file_note.set(str(error))

        self.dispatch(read, draw, failed)

    def up(self):
        chain = getattr(self, 'chain', [])
        self.current = chain[-2]['id'] if len(chain) > 1 else None
        self.file_page = 1
        self.refresh()

    def enter_folder(self, event):
        item = self.files.get(self.file_grid.focus())
        if item and item['kind'] == 'folder':
            self.current = item['id']
            self.file_page = 1
            self.refresh()

    def upload_files(self):
        selected = filedialog.askopenfilenames(title='选择要上传的文件')
        for filename in selected:
            self.enqueue_upload(Path(filename), [], self.folder_id)

    def upload_folder(self):
        folder = filedialog.askdirectory(title='选择要上传的文件夹')
        if not folder:
            return
        folder = Path(folder)
        parent = self.folder_id

        def scan():
            return [item for item in folder.rglob('*') if item.is_file() and not item.is_symlink()]

        def found(paths):
            for path in paths:
                self.enqueue_upload(path, list(path.relative_to(folder.parent).parts[:-1]), parent)
            if not paths:
                self.dispatch(lambda: self.api.request('/fs/mkdir', method='POST', body={'name': folder.name, 'parentId': parent}), lambda result: self.refresh())

        self.dispatch(scan, found)

    def resolve_conflict(self, filename, can_overwrite=True):
        if not can_overwrite:
            rename = messagebox.askyesno('同名文件冲突', f'目标目录已存在“{filename}”。是否自动重命名新文件后上传？')
            return 'rename' if rename else 'skip'
        choice = messagebox.askyesnocancel('同名文件冲突', f'目标目录已存在“{filename}”。\n\n是：覆盖并保留原文件到回收站\n否：自动重命名\n取消：跳过')
        return 'overwrite' if choice is True else 'rename' if choice is False else 'skip'

    def enqueue_upload(self, source, parents, parent, conflict=None):
        def start():
            job = self.api.start_upload(source, parent, parents, self.device, conflict)
            return job if job.get('skipped') else {**job, 'source': str(source), 'sourceMtime': source.stat().st_mtime_ns}

        def failed(error):
            if isinstance(error, APIError) and error.code == 40901 and not conflict:
                strategy = self.resolve_conflict(source.name, error.details.get('canOverwrite', True))
                if strategy != 'skip':
                    self.enqueue_upload(source, parents, parent, strategy)
            else:
                self.status.set(str(error))

        self.dispatch(start, self.accept_job, failed)

    def download_files(self):
        selection = [self.files[key] for key in self.file_grid.selection()]
        if not selection:
            self.status.set('请先选择要下载的文件或文件夹。')
            return
        name = selection[0]['name'] if len(selection) == 1 else '网盘批量下载'
        if len(selection) > 1 or selection[0]['kind'] == 'folder':
            name += '.zip'
        target = filedialog.asksaveasfilename(title='保存到本机', initialfile=name, confirmoverwrite=True)
        if not target:
            return
        overwrite = Path(target).exists()

        def prepare():
            job = self.api.request('/task/download/start', method='POST', body={'fileId': [item['id'] for item in selection], 'device': self.device})
            return {**job, 'target': target, 'overwriteTarget': overwrite}

        self.dispatch(prepare, self.accept_job)

    def accept_job(self, job):
        if job.get('skipped'):
            return
        key, status = job['id'], job['status']
        previous = self.jobs.get(key) or self.downloads.get(key)
        if status in FINISHED:
            self.jobs.pop(key, None)
            self.retry_at.pop(key, None)
            if status == 'success' and job.get('target'):
                self.downloads[key] = job
        else:
            self.jobs[key] = job
        fields = ('status', 'reason', 'source', 'sourceMtime', 'target', 'overwriteTarget', 'resolution')
        if previous is None or any(previous.get(field) != job.get(field) for field in fields):
            persist(self.queue_file, [*self.jobs.values(), *self.downloads.values()])
        self.paint_task(job)
        if status == 'success' and previous and previous['status'] != 'success':
            self.status.set(f'传输已完成 · {job["name"]}')
            if job['type'] == 'upload':
                self.refresh()
        if status in (*FINISHED, 'failed'):
            self.history_changed()
        if previous is None and status in ('paused', 'failed'):
            self.update_task(job, 'resume')

    def paint_task(self, job):
        key = job['id']
        exists = self.task_grid.exists(key)
        if job['status'] in FINISHED:
            if exists:
                self.task_grid.delete(key)
            return
        values = (job['name'], '上传' if job['type'] == 'upload' else '下载',
                  f'{display_size(job["done"])} / {display_size(job["total"])}', TASK_STATES[job['status']])
        if exists:
            self.task_grid.item(key, values=values)
        else:
            self.task_grid.insert('', 'end', iid=key, values=values)

    def control(self, action):
        allowed = {'pause': RUNNABLE, 'resume': ('paused', 'failed'), 'cancel': TASK_STATES.keys()}[action]
        jobs = [self.jobs[key] for key in self.task_grid.selection() if self.jobs[key]['status'] in allowed]
        if not jobs:
            return
        if action == 'cancel' and not messagebox.askyesno('取消传输', f'取消选中的 {len(jobs)} 个任务并清除传输断点？'):
            return
        for job in jobs:
            self.retry_at.pop(job['id'], None)
            self.update_task(job, action)

    def update_task(self, job, action):
        def request_update():
            try:
                result = self.api.control(action, job['id'])
            except APIError as error:
                if action != 'cancel' or error.status != 404:
                    raise
                result = {'status': 'cancelled'}
            if result['status'] == 'cancelled' and job.get('target'):
                partial_path(job).unlink(missing_ok=True)
            updated = {**self.jobs.get(job['id'], job), **result}
            if action == 'resume' and updated['status'] == 'success' and job.get('target') and partial_path(job).exists():
                updated['status'] = 'waiting'
            return updated

        def failed(error):
            self.status.set(str(error))
            if action == 'resume' and isinstance(error, APIError) and error.status == 0:
                self.retry_at[job['id']] = time.monotonic() + 5

        self.dispatch(request_update, self.accept_job, failed)

    def open_download(self, grid=None):
        selection = (grid if grid is not None else self.task_grid).selection()
        if selection:
            job = self.downloads.get(selection[0]) or self.jobs.get(selection[0], {})
            target = job.get('target')
            if target and Path(target).parent.exists():
                os.startfile(str(Path(target).parent))
            else:
                self.status.set('此记录的本地保存位置不可用。')

    def advance(self, job):
        if job['status'] == 'preparing':
            try:
                found = self.api.request('/task/info', query={'taskId': job['id'], 'passive': 1})
            except APIError as error:
                if error.status != 404:
                    raise
                tasks = self.api.request('/task/list', query={'type': 'download', 'active': 1})['list']
                found = next((entry for entry in tasks if entry['id'] == job['id']), None)
                if found is None:
                    raise APIError('下载任务已失效', 404) from error
            return {**job, **found}
        if job['type'] == 'upload':
            return step_upload(self.api, job)
        return step_download(self.api, job)

    def job_failed(self, job, error):
        self.status.set(str(error))
        if isinstance(error, APIError) and error.code == 40901 and job['type'] == 'upload':
            strategy = self.resolve_conflict(job['name'], error.details.get('canOverwrite', True))
            self.accept_job({**job, 'status': 'waiting', 'resolution': strategy})
        elif isinstance(error, APIError) and error.status == 0:
            self.retry_at[job['id']] = time.monotonic() + 4
            self.accept_job({**job, 'status': 'paused', 'reason': str(error)})
        elif isinstance(error, APIError) and error.status == 401:
            self.action_pending.clear()
            self.accept_job({**job, 'status': 'paused', 'reason': str(error)})
            self.api = None
            self.login_screen()
        else:
            reason = str(error)
            self.accept_job({**job, 'status': 'failed', 'reason': reason})
            if isinstance(error, APIError) and error.status == 404:
                return
            self.dispatch(lambda: self.api.control('fail', job['id'], reason=reason),
                          lambda result: self.history_changed(), lambda error: None)

    def poll(self):
        for result in (self.result, self.update_result):
            try:
                callback, value = result.get_nowait()
            except Empty:
                continue
            if result is self.result:
                self.pending = False
            try:
                callback(value)
            except Exception as error:
                self.status.set(str(error))
                if result is self.update_result:
                    self.update_state(str(error))
        interval = 20 if self.pending else 150
        if not self.pending and self.api:
            if self.action_pending:
                self.run(*self.action_pending.popleft())
                interval = 20
            else:
                for key, moment in list(self.retry_at.items()):
                    if time.monotonic() >= moment:
                        self.retry_at.pop(key)
                        if key in self.jobs:
                            self.update_task(self.jobs[key], 'resume')
                            break
                now = time.monotonic()
                job = next((job for job in self.jobs.values() if job['status'] in RUNNABLE
                            and (job['status'] != 'preparing' or now >= self.package_poll)), None)
                if job and not self.action_pending:
                    if job['status'] == 'preparing':
                        self.package_poll = now + 0.75
                    self.run(lambda: self.advance(job), self.accept_job, lambda error: self.job_failed(job, error))
                    interval = 20
        self.poll_timer = self.root.after(interval, self.poll)

    def minimize(self):
        self.status.set('客户端已最小化，排队任务继续在后台运行。')
        self.root.iconify()

    def exit(self):
        active = self.pending or self.updating or any(job['status'] in RUNNABLE for job in self.jobs.values())
        if active and not messagebox.askyesno('退出客户端', '还有任务在处理。退出后可重新登录继续文件传输。是否退出？'):
            return
        self.root.destroy()


def main():
    local = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'LanDriveV1'
    root = tk.Tk()
    if len(sys.argv) == 3 and sys.argv[1] == '--self-check':
        root.withdraw()
        client = Client(root, Path(sys.argv[2]).parent)
        root.update_idletasks()
        assert client.login_button.winfo_exists() and client.address.get()
        client.api = DriveAPI('127.0.0.1:8080')
        client.workspace({'name': '客户端自检'})
        root.update_idletasks()
        assert [client.notebook.tab(tab, 'text') for tab in client.notebook.tabs()][-2:] == ['上传记录', '下载记录']
        assert client.update_button.cget('text') == '检查更新'
        assert all(state['clear'].cget('text') == '清空记录' for state in client.history.values())
        root.destroy()
        Path(sys.argv[2]).write_text('OK', encoding='ascii')
        return
    Client(root, local)
    root.mainloop()


if __name__ == '__main__':
    main()
