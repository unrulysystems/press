# -*- mode: Python -*-
# janitor drains a serve_cmd process group when Tilt dies ungracefully; without
# it the dev server reparents to init and keeps holding its silo-allocated port.
v1alpha1.extension_repo(
    name="janitor",
    url="https://github.com/alleneubank/janitor",
    ref="v0.3.0",
)
v1alpha1.extension(name="janitor", repo_name="janitor", repo_path="tilt/janitor")
load("ext://janitor", "janitor_local_resource")


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
        "PRESS_MAX_METADATA_BYTES": os.getenv("PRESS_MAX_METADATA_BYTES", "1048576"),
    }


def _serve_mode():
    mode = str(os.getenv("PRESS_SERVE_MODE", "dev")).strip().lower()
    if mode not in ["dev", "prod"]:
        fail("PRESS_SERVE_MODE must be dev or prod, got " + mode)
    return mode


def press_localnet():
    _require_silo()
    press_port = _required_port("PRESS_PORT")
    compose_project_name = _required_env("COMPOSE_PROJECT_NAME")
    env = _localnet_env()
    serve_mode = _serve_mode()

    docker_compose("compose.yaml", project_name=compose_project_name)
    dc_resource("postgres", labels=["press"])

    local_resource(
        "db-ready",
        cmd='until docker exec "${COMPOSE_PROJECT_NAME}-postgres-1" pg_isready -h 127.0.0.1 -U press -d press >/dev/null 2>&1; do sleep 0.5; done',
        env={"COMPOSE_PROJECT_NAME": compose_project_name},
        resource_deps=["postgres"],
        labels=["press"],
    )

    local_resource(
        "migrate",
        cmd='mkdir -p "$PRESS_STORAGE_DIR" && nub run --filter @press/web db:migrate',
        env=env,
        resource_deps=["db-ready"],
        labels=["press"],
    )

    local_resource(
        "seed",
        cmd='mkdir -p "$PRESS_STORAGE_DIR" && nub run --filter @press/web db:seed',
        env=env,
        resource_deps=["migrate"],
        labels=["press"],
    )

    if serve_mode == "prod":
        local_resource(
            "build-web",
            cmd="nub run build:web",
            env={
                "NODE_ENV": "production",
                "PRESS_ENABLE_CREDENTIAL_AUTH": "0",
            },
            labels=["press"],
        )

    janitor_local_resource(
        "web",
        serve_cmd='mkdir -p "$PRESS_STORAGE_DIR" && nub run --filter @press/web ' + (
            "serve:prod" if serve_mode == "prod" else "dev"
        ),
        serve_env=env,
        resource_deps=["seed", "build-web"] if serve_mode == "prod" else ["seed"],
        readiness_probe=probe(http_get=http_get_action(port=press_port, path="/healthz")),
        labels=["press"],
    )
