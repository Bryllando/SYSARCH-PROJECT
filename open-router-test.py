# ─── OpenRouter Test Script ────────────────────────────────────────────────
# This is a standalone Python test script. It is NOT used by the Node.js app.
# The actual AI integration is in: services/ai-engine.js (uses fetch, not Python)
#
# To run: python open_router.py
# Requires: pip install openai
# ───────────────────────────────────────────────────────────────────────────

from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="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",
)

response = client.chat.completions.create(
    model="google/gemma-3-4b-it:free",
    max_tokens=200,
    messages=[
        {
            "role": "user",
            "content": "Say hello and return a JSON object with key 'greeting'."
        }
    ],
    extra_headers={
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "CCS SitIn Monitoring System"
    }
)

print(response.choices[0].message.content)