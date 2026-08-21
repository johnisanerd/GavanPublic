"""Trailrun endpoints - one endpoint per file.

All trailrun-related endpoints:
- POST /trailrun - Create a new trailrun
- GET /trailrun/{id} - Get trailrun status
- GET /trailrun/{id}/results - Get experiment results
- POST /trailrun/{id}/design - Generate experiment config
- POST /trailrun/{id}/run - Execute experiment
- POST /trailrun/{id}/summarize - Generate summary
- POST /trailrun/{id}/ask - Answer questions
- POST /trailrun/{id}/cancel - Cancel running trailrun
"""

from src.endpoints.trailrun.ask import router as ask_router
from src.endpoints.trailrun.cancel import router as cancel_router
from src.endpoints.trailrun.create import router as create_router
from src.endpoints.trailrun.design import router as design_router
from src.endpoints.trailrun.get import router as get_router
from src.endpoints.trailrun.results import router as results_router
from src.endpoints.trailrun.run import router as run_router
from src.endpoints.trailrun.summarize import router as summarize_router

# Combined list of all routers for easy inclusion
all_routers = [
    create_router,
    get_router,
    results_router,
    design_router,
    run_router,
    summarize_router,
    ask_router,
    cancel_router,
]

__all__ = [
    "all_routers",
    "ask_router",
    "cancel_router",
    "create_router",
    "design_router",
    "get_router",
    "results_router",
    "run_router",
    "summarize_router",
]
