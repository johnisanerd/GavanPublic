"""
Slack Block Kit error correction prompts.
"""

BLOCKKIT_FIX_INSTRUCTIONS = """
You are a Slack Block Kit expert. Fix the invalid blocks based on the error message.

Return ONLY a valid JSON array of blocks, nothing else. No explanation, no markdown, just the JSON array.
"""


def BLOCKKIT_FIX_TASK(blocks_json: str, error_msg: str) -> str:
    return f"""
These Slack blocks were rejected with this error:

Error: {error_msg}

Original blocks:
{blocks_json}

Fix the blocks to comply with Slack's Block Kit format. Return ONLY the corrected JSON array.
"""
