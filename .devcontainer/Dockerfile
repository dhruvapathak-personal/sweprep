FROM docker.io/library/node:24.22.1-bookworm-slim AS app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git postgresql-client \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /workspace/sweprep
CMD ["sleep", "infinity"]

FROM app AS personal-tools
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    bubblewrap socat slirp4netns python3 python3-venv openssh-client curl \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /home/node/.vscode-server /home/node/.copilot /home/node/.codex
ARG PIXI_VERSION=0.55.0
RUN case "$(dpkg --print-architecture)" in \
    amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://github.com/prefix-dev/pixi/releases/download/v${PIXI_VERSION}/pixi-${arch}-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin pixi
USER node
