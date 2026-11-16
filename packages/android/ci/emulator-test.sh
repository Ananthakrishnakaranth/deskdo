#!/usr/bin/env bash
# Runs inside the CI emulator job (see .github/workflows/ci.yml, job android-emulator), after the
# debug APKs are built and a DeskDo server is listening on the host at $SERVER_PORT.
# Installs the app, lets the tests place its widget, runs them, and collects screenshots into ci-out/.
set -uo pipefail
cd "$(dirname "$0")/.."
APP=app.deskdo.android
mkdir -p ci-out

adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
# Allow the app to host (bind) widgets, so the test can act as a home screen.
adb shell appwidget grantbind --package "$APP" --user 0 || { sleep 5; adb shell appwidget grantbind --package "$APP" --user 0; } \
  || { echo "::error::could not grant widget bind permission"; exit 1; }
adb shell cat /proc/meminfo | head -3
adb logcat -c

adb shell am instrument -w \
  -e server "http://10.0.2.2:${SERVER_PORT}" -e email "$E2E_EMAIL" -e password "$E2E_PASSWORD" \
  "$APP.test/androidx.test.runner.AndroidJUnitRunner" | tee ci-out/instrument.txt

echo "::group::Pending alarms for the app"
adb shell dumpsys alarm | grep -B2 -A6 "$APP" | head -60 || true
echo "::endgroup::"
echo "::group::Test and crash log"
adb logcat -d -s DeskDoTest:I AndroidRuntime:E TestRunner:I ActivityManager:I lowmemorykiller:I | grep -E "DeskDoTest|AndroidRuntime|TestRunner|app.deskdo|lowmemory|Killing" | tail -200 || true
echo "::endgroup::"

# Screenshots the tests saved in the app's private files (readable through run-as on debug builds).
# A missing file makes `cat` print an error instead, so keep only real PNGs (as *.png).
adb exec-out run-as "$APP" cat files/widget.png > ci-out/widget.raw 2>/dev/null || true
adb exec-out run-as "$APP" cat files/setup.png > ci-out/setup.raw 2>/dev/null || true
adb exec-out run-as "$APP" cat files/app.png > ci-out/app.raw 2>/dev/null || true
head -c 4 ci-out/widget.raw | grep -q PNG && mv ci-out/widget.raw ci-out/widget.png
head -c 4 ci-out/setup.raw | grep -q PNG && mv ci-out/setup.raw ci-out/setup.png
head -c 4 ci-out/app.raw | grep -q PNG && mv ci-out/app.raw ci-out/app.png
ls -la ci-out

# The widget must have armed its refresh alarm.
adb shell dumpsys alarm | grep -q "$APP.TICK" || { echo "::error::refresh alarm is not scheduled"; exit 1; }
grep -q "^OK (" ci-out/instrument.txt || { echo "::error::instrumented tests failed"; exit 1; }
