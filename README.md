# Rollback Project Demo

A DevOps-focused deployment system that builds Docker images, deploys a new version, checks health via API, and rolls back automatically if the health check fails.

## What is included
- Three app versions (`app_v1.js`, `app_v2.js`, `app_v3.js`) with health endpoints (v3 is intentionally unhealthy)
- A Node.js controller (`controller.js`) that triggers deployments and streams logs
- A web dashboard (`dashboard.html`) served by the controller
- Dockerfile with build arg support for versioned images
- Jenkins pipeline (`Jenkinsfile`) for build and Docker run
- Rollback script (`deploy.bat`)

## Review 1 demo flow
1) Start the controller
```
node controller.js
```

2) Open the dashboard
- URL: http://localhost:5000/

3) Trigger deployments in order
- Click "Deploy v1" to start with the stable baseline
- Click "Deploy v2" to show a successful upgrade
- Click "Deploy v3" to trigger a failed health check and automatic rollback to v2 (or v1 if v2 fails)

4) Verify Docker image creation
```
docker images
```

## Jenkins pipeline
- Use the included `Jenkinsfile`.
- The pipeline stages are: Build, Docker Build, Run Container, Smoke Test, and optional Docker Push.
- To enable Docker push, set credentials in Jenkins as environment variables:
  - `DOCKER_USER`
  - `DOCKER_PASS`

## Dashboard + Jenkins integration
- The dashboard (served by `controller.js`) can show Jenkins status and trigger builds.
- Configure these environment variables before starting the controller:
  - `JENKINS_URL` (default: `http://localhost:8080`)
  - `JENKINS_JOB` (default: `rollback-pipeline`)
  - `JENKINS_USER` and `JENKINS_TOKEN` (API token for authenticated Jenkins)
  - `JENKINS_TRIGGER_TOKEN` (optional, if you enabled remote build tokens)

## API endpoints
- App: `GET /status` or `GET /health`
- Controller: `POST /deploy?version=v1|v2|v3`, `GET /deploy/status`, `GET /deploy/logs`

## Notes
- For the demo, run the app through Docker, not directly from the IDE.
- The controller can run locally because it orchestrates Docker deployments and rollback.
