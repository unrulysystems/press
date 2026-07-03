def _required_env(name):
    value = os.getenv(name)
    if value == None or str(value).strip() == "":
        fail("Missing required silo environment variable: " + name + ". Run `silo up` or `silo ci`.")
    return str(value)


def _required_port(name):
    value = _required_env(name)
    port = int(value)
    if port < 1 or port > 65535:
        fail(name + " must be between 1 and 65535, got " + value)
    return port


def _require_silo():
    active = str(os.getenv("SILO_ACTIVE") or "").strip().lower()
    if active not in ["1", "true", "yes"]:
        fail("This Tiltfile must be run by silo. Use `silo up` or `silo ci`.")
    _required_env("SILO_WORKSPACE")
    _required_env("SILO_ENV_FILE")


def _localnet_env():
    workspace = _required_env("SILO_WORKSPACE")
    return {
        "NODE_ENV": os.getenv("NODE_ENV", "development"),
        "PRESS_PORT": _required_env("PRESS_PORT"),
        "PRESS_POSTGRES_PORT": _required_env("PRESS_POSTGRES_PORT"),
        "PRESS_BASE_URL": _required_env("PRESS_BASE_URL"),
        "DATABASE_URL": _required_env("DATABASE_URL"),
        "PRESS_ALLOWED_DOMAINS": os.getenv("PRESS_ALLOWED_DOMAINS", "send.it"),
        "PRESS_ADMIN_EMAILS": os.getenv("PRESS_ADMIN_EMAILS", "admin@send.it"),
        "PRESS_STORAGE_DIR": os.getenv("PRESS_STORAGE_DIR", ".press/silo/" + workspace + "/storage"),
        "BETTER_AUTH_SECRET": os.getenv("BETTER_AUTH_SECRET", "localnet-secret-at-least-32-bytes"),
        "PRESS_ENABLE_CREDENTIAL_AUTH": os.getenv("PRESS_ENABLE_CREDENTIAL_AUTH", "1"),
        "PRESS_MAX_UPLOAD_BYTES": os.getenv("PRESS_MAX_UPLOAD_BYTES", "26214400"),
    }


def press_localnet():
    _require_silo()
    press_port = _required_port("PRESS_PORT")
    env = _localnet_env()

    docker_compose("compose.yaml", project_name=_required_env("COMPOSE_PROJECT_NAME"))
    dc_resource("postgres", labels=["press"])

    local_resource(
        "migrate",
        cmd='mkdir -p "$PRESS_STORAGE_DIR" && nub run --filter @press/web db:migrate',
        env=env,
        resource_deps=["postgres"],
        labels=["press"],
    )

    local_resource(
        "seed",
        cmd='mkdir -p "$PRESS_STORAGE_DIR" && nub run --filter @press/web db:seed',
        env=env,
        resource_deps=["migrate"],
        labels=["press"],
    )

    local_resource(
        "web",
        serve_cmd='mkdir -p "$PRESS_STORAGE_DIR" && nub run --filter @press/web dev',
        serve_env=env,
        resource_deps=["seed"],
        readiness_probe=probe(http_get=http_get_action(port=press_port, path="/healthz")),
        labels=["press"],
    )
