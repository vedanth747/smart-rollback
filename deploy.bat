@echo off
setlocal

set IMAGE_NAME=rollback-app
set CONTAINER_NAME=rollback_app
set APP_FILE=%1
set COMMIT_SHA=%2

if "%APP_FILE%"=="" set APP_FILE=app_v2.js
if "%COMMIT_SHA%"=="" set COMMIT_SHA=latest

echo Building image for %APP_FILE% (commit %COMMIT_SHA%)...
docker build --build-arg APP_FILE=%APP_FILE% -t %IMAGE_NAME%:%COMMIT_SHA% .
if %errorlevel% neq 0 (
    echo RESULT: build failed
    exit /b 1
)

echo Stopping existing container...
docker rm -f %CONTAINER_NAME% >nul 2>&1

echo Starting container (commit %COMMIT_SHA%)...
docker run -d -p 3000:3000 --name %CONTAINER_NAME% %IMAGE_NAME%:%COMMIT_SHA%
if %errorlevel% neq 0 (
    echo RESULT: container start failed
    exit /b 2
)

timeout /t 5 >nul

set HTTP_CODE=
for /f %%i in ('curl -s -o nul -w "%%{http_code}" http://localhost:3000/status') do set HTTP_CODE=%%i
echo Health check status code: %HTTP_CODE%

if "%HTTP_CODE%"=="200" (
    echo Tagging %COMMIT_SHA% as last-good...
    docker tag %IMAGE_NAME%:%COMMIT_SHA% %IMAGE_NAME%:last-good
    echo RESULT: deployed %COMMIT_SHA%
    exit /b 0
)

echo Health check failed for %COMMIT_SHA%. Rolling back...
docker rm -f %CONTAINER_NAME% >nul 2>&1

docker image inspect %IMAGE_NAME%:last-good >nul 2>&1
if %errorlevel% neq 0 (
    echo No last-good image found
    echo RESULT: rollback failed - no stable image
    exit /b 1
)

docker run -d -p 3000:3000 --name %CONTAINER_NAME% %IMAGE_NAME%:last-good
if %errorlevel% neq 0 (
    echo RESULT: rollback failed
    exit /b 1
)

echo RESULT: rolled back to last-good
exit /b 0