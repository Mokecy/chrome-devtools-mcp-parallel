@echo off
REM ============================================
REM  chrome-devtools-mcp-parallel Release Script
REM  Usage: release.bat [patch|minor|major]
REM  Publishing handled by GitHub Actions on tag push
REM ============================================

setlocal

set VERSION_TYPE=%1
if "%VERSION_TYPE%"=="" set VERSION_TYPE=patch

echo.
echo ========================================
echo  chrome-devtools-mcp-parallel Release
echo  Version bump: %VERSION_TYPE%
echo ========================================
echo.

REM Check for uncommitted changes
git diff --quiet 2>nul
if errorlevel 1 (
    echo [!] Working tree dirty. Commit first.
    git status --short
    exit /b 1
)

REM Bump version (no git tag, we tag manually after to control message)
echo [1/3] npm version %VERSION_TYPE%...
call npm version %VERSION_TYPE% --no-git-tag-version
if errorlevel 1 (
    echo [ERROR] npm version failed
    exit /b 1
)

REM Read new version
for /f "tokens=*" %%i in ('node -e "console.log(require('./package.json').version)"') do set NEW_VERSION=%%i
echo        New version: v%NEW_VERSION%

REM Commit + tag
echo [2/3] git commit + tag...
git add package.json package-lock.json
git commit -m "release: v%NEW_VERSION%"
git tag -a "v%NEW_VERSION%" -m "Release v%NEW_VERSION%"
if errorlevel 1 (
    echo [ERROR] git tag failed
    exit /b 1
)

REM Push -> triggers publish.yml
echo [3/3] git push + tags (triggers CI publish)...
git push
git push --tags
if errorlevel 1 (
    echo [ERROR] git push failed
    exit /b 1
)

echo.
echo ========================================
echo  Pushed v%NEW_VERSION%
echo  GitHub Actions will publish to npm.
echo ========================================
echo   Actions: https://github.com/Mokecy/chrome-devtools-mcp-parallel/actions
echo   npm:     https://www.npmjs.com/package/chrome-devtools-mcp-parallel
echo   Use:     npx chrome-devtools-mcp-parallel@latest
echo.

endlocal
