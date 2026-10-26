FROM docker.io/library/ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944 AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git libstdc++6 postgresql-client \
    && rm -rf /var/lib/apt/lists/*
RUN case "$(dpkg --print-architecture)" in \
    amd64) arch=x64; checksum=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c ;; \
    arm64) arch=arm64; checksum=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3 ;; \
    *) exit 1 ;; esac \
    && curl -fsSL "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-${arch}.tar.gz" -o /tmp/node.tar.gz \
    && printf '%s  /tmp/node.tar.gz\n' "$checksum" | sha256sum -c - \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.gz \
    && test "$(node --version)" = v24.22.1 \
    && test "$(npm --version)" = 11.19.1
RUN groupmod --new-name dhruva ubuntu \
    && usermod --login dhruva --home /home/dhruva --move-home --groups "" ubuntu \
    && install -d -o dhruva -g dhruva /workspace/sweprep
ENV HOME=/home/dhruva
WORKDIR /workspace/sweprep
CMD ["sleep", "infinity"]
FROM base AS app
USER dhruva

FROM base AS personal-tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    bubblewrap socat slirp4netns python3 python3-venv openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o dhruva -g dhruva \
    /home/dhruva/.vscode-server /home/dhruva/.copilot /home/dhruva/.codex \
    /home/dhruva/.pixi /home/dhruva/.pixi/bin
COPY --from=ghcr.io/prefix-dev/pixi:0.55.0@sha256:423daf63e4e876ab42b1be9ddee3fc867ba8b9fa511e0634de3b9df12ff1a90d --chown=dhruva:dhruva /usr/local/bin/pixi /home/dhruva/.pixi/bin/pixi
ENV PIXI_HOME=/home/dhruva/.pixi
ENV PATH="/home/dhruva/.pixi/bin:${PATH}"
USER dhruva
