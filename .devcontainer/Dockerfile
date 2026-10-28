# Shared runtime dependencies
FROM docker.io/library/ubuntu:26.04 AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 curl \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /usr/share/keyrings/nodesource.asc \
    && echo "deb [signed-by=/usr/share/keyrings/nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends 'nodejs=24.*' \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*
RUN groupmod --new-name dhruva ubuntu \
    && usermod --login dhruva --home /home/dhruva --move-home --groups "" ubuntu \
    && install -d -o dhruva -g dhruva /workspace/sweprep
ENV HOME=/home/dhruva
WORKDIR /workspace/sweprep

FROM base AS release
USER dhruva
CMD ["npm", "start"]

FROM base AS dev
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    curl git postgresql-client bubblewrap socat slirp4netns python3 python3-venv openssh-client sudo \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'dhruva ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/dhruva \
    && chmod 0440 /etc/sudoers.d/dhruva \
    && visudo -cf /etc/sudoers.d/dhruva \
    && install -d -o dhruva -g dhruva \
    /home/dhruva/.vscode-server /home/dhruva/.copilot /home/dhruva/.codex \
    /home/dhruva/.pixi /home/dhruva/.pixi/bin \
    /opt/devcontainer-mcp/npm /opt/devcontainer-mcp/playwright-browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/devcontainer-mcp/playwright-browsers
RUN npm install --global --prefix /opt/devcontainer-mcp/npm --no-audit --no-fund \
    @modelcontextprotocol/server-filesystem@2.0.1 \
    @playwright/mcp@0.0.83 \
    playwright@1.64.0-alpha-1790635538000 \
    podman-mcp-server@0.0.15 \
    && python3 -m venv /opt/devcontainer-mcp/git-venv \
    && /opt/devcontainer-mcp/git-venv/bin/pip install --no-cache-dir \
    "git+https://github.com/modelcontextprotocol/servers.git@ef9808f71090d0db3eda99e2af2ba78f1086f4fb#subdirectory=src/git" \
    && /opt/devcontainer-mcp/npm/bin/playwright install-deps chromium \
    && /opt/devcontainer-mcp/npm/bin/playwright install chromium
RUN curl -fsSL https://pixi.sh/install.sh -o /tmp/install-pixi.sh \
    && PIXI_BIN_DIR=/usr/local/bin PIXI_NO_PATH_UPDATE=1 PIXI_NO_TELEMETRY=1 sh /tmp/install-pixi.sh \
    && rm /tmp/install-pixi.sh
ENV PIXI_HOME="${HOME}/.pixi"
ENV PATH="${PIXI_HOME}/bin:${PATH}"
USER dhruva
CMD ["sleep", "infinity"]
