# LiteLLM proxy for the imessage-coding conversational assistant.
#
# The `-database` image bakes in the Prisma engine and auto-runs `prisma migrate
# deploy` on boot, so spend tracking / virtual keys / end-user budgets work with
# just a DATABASE_URL — no separate migration step for a single machine.
FROM ghcr.io/berriai/litellm-database:main-stable

COPY config.yaml /app/config.yaml

# Entrypoint is `litellm`; these args append to it. Binds 0.0.0.0:4000 by default
# (required for Fly flycast/private routing). Port matches fly.toml internal_port.
CMD ["--config", "/app/config.yaml", "--port", "4000"]
