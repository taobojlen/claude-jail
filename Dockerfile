FROM oven/bun:latest AS channel-build
WORKDIR /app
COPY scheduler/channel/package.json scheduler/channel/bun.lock* ./
RUN bun install
COPY scheduler/channel/scheduler-channel.ts .
RUN bun build --compile --outfile=scheduler-channel scheduler-channel.ts

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    sudo \
    git \
    tini \
    jq \
    expect \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash claude \
    && echo "claude ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/claude \
    && chmod 0440 /etc/sudoers.d/claude

USER claude
RUN git config --global init.defaultBranch main \
    && git config --global user.name "Claude Code" \
    && git config --global user.email "noreply@anthropic.com"
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/claude/.local/bin:$PATH"

COPY --from=channel-build /app/scheduler-channel /opt/scheduler-channel/scheduler-channel

COPY --chown=claude:claude entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR /home/claude

ENTRYPOINT ["tini", "--", "/opt/entrypoint.sh"]
