Use macos-checks to run the configured iOS checks on the macOS worker.
Report the actual checkout/revision if the recipe supplies it, available
simulators, test failures, and output locations. A Linux build is not proof of
an iOS Simulator run. If the worker is unavailable or busy, report that state.

When macos_release is available, keep the VM for related checks in this job,
then release it when finished. Host leases do not authorize arbitrary shell
commands or imply that a checkout has been synchronized.
