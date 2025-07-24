import os
import sys
import json
import time
import signal
import threading
from subprocess import Popen, PIPE
import datetime
import subprocess
from flask import Flask, render_template_string, send_from_directory, request
from flask_socketio import SocketIO, emit

PORT = 8000
GEMINI_CLI_PATH = '/home/geminicli/.nvm/versions/node/v22.17.1/bin/gemini'
geminicli_process = None

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

def start_geminicli():
    global geminicli_process
    if geminicli_process and geminicli_process.poll() is None:
        return
    geminicli_process = Popen(
        [GEMINI_CLI_PATH, '--experimental-acp'],
        stdin=PIPE, stdout=PIPE, stderr=PIPE, text=True, bufsize=1
    )
    threading.Thread(target=read_stdout).start()
    threading.Thread(target=read_stderr).start()

def read_stdout():
    while True:
        line = geminicli_process.stdout.readline()
        if not line:
            break
        for msg in line.strip().split('\n'):
            try:
                j = json.loads(msg)
                socketio.emit('cli_output', j.get('params', j), namespace='/')
            except:
                socketio.emit('cli_output', {'stdout': msg}, namespace='/')
    shutdown_cli()

def read_stderr():
    while True:
        err = geminicli_process.stderr.readline()
        if not err:
            break
        socketio.emit('cli_output', {'stderr': err.strip()}, namespace='/')

def shutdown_cli():
    global geminicli_process
    if geminicli_process and geminicli_process.poll() is None:
        geminicli_process.terminate()
        geminicli_process.wait(timeout=5)
    geminicli_process = None

@app.route('/')
def index():
    with open('index.html', encoding='utf-8') as f:
        return render_template_string(f.read())

@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('.', filename)

@app.route('/run-python-script')
def run_python_script():
    try:
        date_str = request.args.get('date')
        if not date_str:
            date_str = datetime.date.today().strftime('%Y-%m-%d')

        command = ["python3", "manage_log.py", "logs_json_for_date", date_str]
        output = subprocess.check_output(command)
        return output, 200, {'Content-Type': 'application/json'}
    except subprocess.CalledProcessError as e:
        error_details = e.output.decode('utf-8') if e.output else "詳細不明: manage_log.pyがエラーを返しましたが、出力がありませんでした。"
        error_message = {"error": "スクリプトの実行に失敗しました", "details": error_details}
        return json.dumps(error_message), 500, {'Content-Type': 'application/json'}

@socketio.on('connect')
def on_connect():
    start_geminicli()
    # initialize
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "0.0.9"}
    }
    geminicli_process.stdin.write(json.dumps(init) + '\n')
    geminicli_process.stdin.flush()

@socketio.on('send_command')
def on_send(data):
    text = data.get('command','').strip()
    if not text:
        emit('cli_output', {'stderr': 'No command provided'}, namespace='/')
        return
    # after initialize, you may authenticate if needed; skip here
    req = {
        "jsonrpc":"2.0",
        "id": int(time.time()*1000),
        "method":"sendUserMessage",
        "params":{"chunks":[{"text": text}]}
    }
    geminicli_process.stdin.write(json.dumps(req) + '\n')
    geminicli_process.stdin.flush()


@socketio.on('disconnect')
def on_disconnect():
    shutdown_cli()

def handle_signal(sig, frame):
    shutdown_cli()
    sys.exit(0)

signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

if __name__=='__main__':
    socketio.run(app, host='0.0.0.0', port=PORT)