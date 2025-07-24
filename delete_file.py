import os
import sys

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python delete_file.py <file_path>")
        sys.exit(1)
    
    file_to_delete = sys.argv[1]
    try:
        import subprocess
        subprocess.run(["trash", file_to_delete])
        print(f"Successfully deleted: {file_to_delete}")
    except OSError as e:
        print(f"Error deleting {file_to_delete}: {e}")
        sys.exit(1)
