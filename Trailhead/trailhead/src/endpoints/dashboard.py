"""GET /trailruns - HTML Dashboard for trailruns."""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from src.trailrun import list_active_trailruns, list_trailruns

router = APIRouter()


@router.get("/trailruns")
async def trailruns_dashboard() -> HTMLResponse:
    """HTML dashboard showing all trailruns with status and cancel buttons."""
    trailruns = list_trailruns()
    active_ids = set(list_active_trailruns())

    rows = []
    for tr in sorted(trailruns, key=lambda t: t.created_at, reverse=True):
        is_active = tr.id in active_ids
        status_badge = "🟢 running" if is_active else f"⚪ {tr.status}"

        cancel_btn = (
            f'<button onclick="cancelRun(\'{tr.id}\')" style="padding:4px 12px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer">Cancel</button>'
            if is_active
            else ""
        )

        view_link = (
            f'<a href="/data-inspector/{tr.id}" target="_blank">View</a>'
            if tr.static_inspect_viewer_path
            else ""
        )

        models = ", ".join(tr.config.models) if tr.config else "—"
        prompts_count = len(tr.config.prompts) if tr.config else 0

        rows.append(f"""
            <tr>
                <td style="font-family:monospace;font-size:12px">{tr.id}</td>
                <td>{status_badge}</td>
                <td>{tr.phase.value}</td>
                <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">{models}</td>
                <td>{prompts_count}</td>
                <td>{tr.created_at.strftime("%H:%M:%S")}</td>
                <td>{view_link}</td>
                <td>{cancel_btn}</td>
            </tr>
        """)

    table_rows = (
        "".join(rows)
        or "<tr><td colspan='8' style='text-align:center;color:#999'>No trailruns yet</td></tr>"
    )

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Trailhead Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; background: #f5f5f5; }}
            h1 {{ color: #333; }}
            table {{ width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
            th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #eee; }}
            th {{ background: #f8f9fa; font-weight: 600; color: #666; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }}
            tr:hover {{ background: #f8f9fa; }}
            button:hover {{ opacity: 0.9; }}
            a {{ color: #007bff; text-decoration: none; }}
            a:hover {{ text-decoration: underline; }}
        </style>
    </head>
    <body>
        <h1>🏃 Trailhead Dashboard</h1>
        <p style="color:#666">Active trailruns: <strong>{len(active_ids)}</strong></p>
        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Status</th>
                    <th>Phase</th>
                    <th>Models</th>
                    <th>Prompts</th>
                    <th>Created</th>
                    <th>Data</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                {table_rows}
            </tbody>
        </table>
        <script>
            async function cancelRun(id) {{
                if (!confirm(`Cancel trailrun ${{id}}?`)) return;
                const res = await fetch(`/trailrun/${{id}}/cancel`, {{ method: 'POST' }});
                if (res.ok) {{
                    alert('Cancelled!');
                    location.reload();
                }} else {{
                    alert('Failed to cancel');
                }}
            }}

            // Auto-refresh every 3 seconds
            setTimeout(() => location.reload(), 3000);
        </script>
    </body>
    </html>
    """

    return HTMLResponse(content=html)
