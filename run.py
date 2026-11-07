"""Start BogniGuard: .venv/bin/python run.py, then open http://127.0.0.1:7878"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("bogniguard.server:app", host="127.0.0.1", port=7878)
