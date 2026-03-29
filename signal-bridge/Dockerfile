FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    openjdk-25-jre-headless \
    && rm -rf /var/lib/apt/lists/*

ARG SIGNAL_CLI_VERSION=0.14.1
RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
    | tar xz -C /opt \
    && ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli

RUN useradd -m -s /bin/bash signal

USER signal
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/signal/.bun/bin:$PATH"

COPY --chown=signal:signal package.json /home/signal/bridge/package.json
RUN cd /home/signal/bridge && bun install

COPY --chown=signal:signal signal-bridge.ts /home/signal/bridge/signal-bridge.ts

WORKDIR /home/signal/bridge

ENTRYPOINT ["bun", "run", "signal-bridge.ts"]
