"""
Media/image generation prompts and tool definitions.
"""

CREATE_MEDIA_TOOL = {
    "type": "function",
    "function": {
        "name": "create_media",
        "description": """
Generate an image based on experiment data.

ONLY use this tool when the user explicitly asks for a visual, chart, graph, image, infographic, or similar.
Do NOT use this tool for general questions - just answer with text instead.

For data visualizations (default): Pick ONE interesting finding. Keep it tight:
- A single compelling quote
- 2 things to compare (A vs B)
- 3-5 data points max
- One key insight
Format options: chart, table, comparison, leaderboard, flowchart, quote_card.

Exception: If the user asks for something creative (e.g., "oil painting", "illustration of a robot"), follow their vision instead - the image should still relate to the experiment data but doesn't need to follow the data viz format.

IMPORTANT: If you use this tool, do not include additional text commentary - the image IS the complete answer.
""",
        "parameters": {
            "type": "object",
            "properties": {
                "visual_type": {
                    "type": "string",
                    "description": "Type of visual: chart, table, comparison, leaderboard, flowchart, or quote_card",
                },
                "data": {
                    "type": "string",
                    "description": "The specific data/finding to visualize. Include exact numbers, model names, and the key insight. Be specific.",
                },
                "headline": {
                    "type": "string",
                    "description": "Short punchy headline (3-7 words) that captures the key finding.",
                },
            },
            "required": ["visual_type", "data", "headline"],
        },
    },
}


def IMAGE_GENERATION(visual_type: str, data: str, headline: str) -> str:
    """
    Build prompt for Gemini image generation.
    """
    return f"""
Create a {visual_type} for social media.

CONTENT TO SHOW:
{headline}

{data}

STYLE: Modern web UI aesthetic. Dark mode with subtle gradients. Clean, minimal, professional. Like a polished dashboard or data viz app. NOT sci-fi. High resolution, detailed.

TEXT: Extremely minimal. Big numbers, short labels. No sentences. Scannable at a glance while scrolling.

SIMPLICITY: Less is more. Generous white space. One clear visual hierarchy. Don't cram details.

BRANDING: Small "Palisade Research" text in corner. NO logo. Optional subtle decorative element: vertical rounded pointed wooden logs (like a fort palisade wall). NO crossbars, just vertical logs. Partial/asymmetric placement OK.

Square format with comfortable margins.
"""
