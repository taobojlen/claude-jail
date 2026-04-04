FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    sudo \
    git \
    cron \
    tini \
    jq \
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

COPY --chown=claude:claude entrypoint.sh /home/claude/entrypoint.sh
RUN chmod +x /home/claude/entrypoint.sh

WORKDIR /home/claude

ENTRYPOINT ["tini", "--", "/home/claude/entrypoint.sh"]
