FROM oven/bun:latest AS scheduler-channel-build
WORKDIR /app
COPY scheduler/channel/package.json scheduler/channel/bun.lock* ./
RUN bun install
COPY scheduler/channel/scheduler-channel.ts .
RUN bun build --compile --outfile=scheduler-channel scheduler-channel.ts

FROM oven/bun:latest AS matrix-channel-build
WORKDIR /app
COPY matrix/channel/package.json matrix/channel/bun.lock* ./
RUN bun install
COPY matrix/channel/matrix-channel.ts .
RUN bun build --compile --outfile=matrix-channel matrix-channel.ts

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    sudo \
    git \
    tini \
    jq \
    expect \
    cron \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu

USER ubuntu
RUN git config --global init.defaultBranch main \
    && git config --global user.name "Claude Code" \
    && git config --global user.email "noreply@anthropic.com"
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/ubuntu/.local/bin:$PATH"

COPY --from=scheduler-channel-build /app/scheduler-channel /opt/scheduler-channel/scheduler-channel
COPY --from=matrix-channel-build /app/matrix-channel /opt/matrix-channel/matrix-channel

COPY --chown=ubuntu:ubuntu dream/ /opt/dream/
RUN chmod +x /opt/dream/dream.sh

COPY --chown=ubuntu:ubuntu entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR /home/ubuntu

ENTRYPOINT ["tini", "--", "/opt/entrypoint.sh"]
