@echo off
setlocal

set IMAGE_NAME=rollback-app
set CONTAINER_NAME=rollback_app
set TARGET_VERSION=%1

if "%TARGET_VERSION%"=="" set TARGET_VERSION=v3

call :build_images
if %errorlevel% neq 0 goto end

call :run_version %TARGET_VERSION%
if %errorlevel%==0 (
    echo Deployment successful (%TARGET_VERSION%)
    echo RESULT: deployed %TARGET_VERSION%
    goto end
)

if /I "%TARGET_VERSION%"=="v3" (
    echo Deployment failed. Rolling back to v2...
    call :run_version v2
    if %errorlevel%==0 (
        echo Rollback to v2 successful
        echo RESULT: rolled back to v2
        goto end
    )

    echo v2 failed. Rolling back to v1...
    call :run_version v1
    if %errorlevel%==0 (
        echo Rollback to v1 successful
        echo RESULT: rolled back to v1
        goto end
    )

    echo Rollback failed
    echo RESULT: rollback failed
    goto end
)

echo %TARGET_VERSION% failed health check
echo RESULT: %TARGET_VERSION% failed health check
goto end

:build_images
echo Building images...
docker build --build-arg APP_FILE=app_v1.js -t %IMAGE_NAME%:v1 .
if %errorlevel% neq 0 exit /b 1

docker build --build-arg APP_FILE=app_v2.js -t %IMAGE_NAME%:v2 .
if %errorlevel% neq 0 exit /b 1

docker build --build-arg APP_FILE=app_v3.js -t %IMAGE_NAME%:v3 .
if %errorlevel% neq 0 exit /b 1

exit /b 0

:run_version
set VERSION=%~1

echo Stopping existing container...
docker rm -f %CONTAINER_NAME% >nul 2>&1

echo Starting target version (%VERSION%)...
docker run -d -p 3000:3000 --name %CONTAINER_NAME% %IMAGE_NAME%:%VERSION%
if %errorlevel% neq 0 exit /b 2

timeout /t 5 >nul

set HTTP_CODE=
for /f %%i in ('curl -s -o nul -w "%%{http_code}" http://localhost:3000/status') do set HTTP_CODE=%%i
echo Health check status code: %HTTP_CODE%
if "%HTTP_CODE%"=="200" exit /b 0
exit /b 1

:end
endlocal