# Interactive Dev Container; the offline runner uses a separate Containerfile.
FROM docker.io/library/ubuntu:26.04
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git openssh-client bash ca-certificates curl jq bubblewrap socat slirp4netns iptables sudo \
    python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && if id ubuntu >/dev/null 2>&1; then \
    groupmod --new-name dhruva ubuntu \
    && usermod --login dhruva --home /home/dhruva --move-home --shell /bin/bash ubuntu; \
    else \
    groupadd --gid 1000 dhruva \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash dhruva; \
    fi \
    && test "$(id -u dhruva)" = 1000 \
    && test "$(id -g dhruva)" = 1000
COPY --from=ghcr.io/prefix-dev/pixi:latest /usr/local/bin/pixi /usr/local/bin/pixi
# Fresh named volumes inherit ownership from their image mountpoints.
RUN install -d -m 0755 -o dhruva -g dhruva \
    /home/dhruva/.vscode-server \
    /home/dhruva/.copilot \
    /home/dhruva/.codex
RUN printf '%s\n' 'dhruva ALL=(ALL:ALL) NOPASSWD: ALL' \
    > /etc/sudoers.d/dhruva \
    && chmod 0440 /etc/sudoers.d/dhruva \
    && visudo -cf /etc/sudoers
USER dhruva
ENV HOME=/home/dhruva
WORKDIR /workspace
RUN python3 --version && pixi --version
CMD ["sleep", "infinity"]
