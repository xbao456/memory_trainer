import os
import sys
from datetime import datetime

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from database import (
    get_user_stats, start_session, add_attempt, finish_session,
    get_user_history, game_type_exists
)

app = FastAPI(title="Memory Trainer API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class StartRequest(BaseModel):
    user_uid: str = Field(min_length=1, max_length=64)
    game_type: str


class AttemptRequest(BaseModel):
    session_id: int
    is_correct: bool
    reaction_time: float = Field(ge=0, le=600)


class FinishRequest(BaseModel):
    session_id: int
    score: int = Field(ge=0)
    max_score: int = Field(ge=0)
    won: bool


def game_params(game_type, difficulty):
    if game_type == 'cards':
        return {
            'pairs': 8,
            'time_limit': max(40, 80 - int(difficulty * 8)),
        }
    if game_type == 'math':
        ops = ['+', '-']
        if difficulty >= 2:
            ops.append('x')
        return {
            'max_num': int(10 + difficulty * 10),
            'ops': ops,
            'problems': 10,
            'time_limit': 60,
        }
    return {
        'start_length': 2 + int(difficulty),
        'show_ms': max(300, 700 - int(difficulty * 80)),
        'levels': 7,
    }


@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.get("/api/stats/{user_uid}")
async def stats(user_uid: str):
    return get_user_stats(user_uid)


@app.post("/api/session/start")
async def session_start(req: StartRequest):
    if not game_type_exists(req.game_type):
        raise HTTPException(400, "unknown game type")
    session_id, difficulty = start_session(req.user_uid, req.game_type)
    return {
        "session_id": session_id,
        "difficulty": difficulty,
        "params": game_params(req.game_type, difficulty),
    }


@app.post("/api/attempt")
async def attempt(req: AttemptRequest):
    if not add_attempt(req.session_id, req.is_correct, req.reaction_time):
        raise HTTPException(404, "session not found or already finished")
    return {"success": True}


@app.post("/api/session/finish")
async def session_finish(req: FinishRequest):
    data = finish_session(req.session_id, req.score, req.max_score, req.won)
    if data is None:
        raise HTTPException(404, "session not found or already finished")
    return {"success": True, **data}


@app.get("/api/history/{user_uid}")
async def history(user_uid: str, limit: int = Query(50, ge=1, le=200)):
    return {"history": get_user_history(user_uid, limit)}


if getattr(sys, 'frozen', False):
    frontend_path = os.path.join(sys._MEIPASS, "frontend")
else:
    frontend_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
