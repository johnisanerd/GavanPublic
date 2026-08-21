"""Tests for FastAPI main application."""

from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


def test_root_endpoint():
    """Test root endpoint returns ok status."""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "message" in data


def test_health_endpoint():
    """Test health check endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_trailrun_create_endpoint():
    """Test POST /trailrun creates a new trailrun."""
    response = client.post("/trailrun", json={"source": "api"})
    assert response.status_code == 200
    data = response.json()
    assert "trailrun_id" in data
    assert data["trailrun_id"].startswith("tr_")


def test_trailrun_get_endpoint():
    """Test GET /trailrun/{id} returns trailrun status."""
    # First create one
    create_response = client.post("/trailrun", json={"source": "api"})
    trailrun_id = create_response.json()["trailrun_id"]

    # Then get it
    response = client.get(f"/trailrun/{trailrun_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["trailrun_id"] == trailrun_id
    assert data["phase"] == "design"
    assert data["status"] == "pending"


def test_trailrun_get_not_found():
    """Test GET /trailrun/{id} returns 404 for unknown ID."""
    response = client.get("/trailrun/tr_nonexistent")
    assert response.status_code == 404
