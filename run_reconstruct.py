import subprocess
import json

with open("/home/geminicli/GeminiCLI/reconstruct_data.json", "r") as f:
    json_data = f.read()

command = ["python", "/home/geminicli/GeminiCLI/manage_log.py", "reconstruct", json_data]
subprocess.call(command)
