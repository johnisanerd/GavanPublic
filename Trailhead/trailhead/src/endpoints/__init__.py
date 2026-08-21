"""API endpoint routers - one endpoint per file."""

from src.endpoints.dashboard import router as dashboard_router
from src.endpoints.data_inspector import router as data_inspector_router
from src.endpoints.generate_run_summarize import router as generate_run_summarize_router
from src.endpoints.health import router as health_router
from src.endpoints.ranger import list_router as ranger_list_router
from src.endpoints.ranger import run_router as ranger_run_router
from src.endpoints.trailrun import all_routers as trailrun_routers
from src.endpoints.trailruns_list import router as trailruns_list_router

__all__ = [
    "dashboard_router",
    "data_inspector_router",
    "generate_run_summarize_router",
    "health_router",
    "ranger_list_router",
    "ranger_run_router",
    "trailrun_routers",
    "trailruns_list_router",
]
