/**
 * Side-effect module for command-line tools whose stdout carries data (for
 * example the API key). It must be the FIRST import: @taskflow/config reads
 * LOG_LEVEL when it is first loaded, and the shared logger writes to stdout.
 * `fatal` suppresses the info/warn/error lines that would otherwise follow
 * the output.
 */
process.env.LOG_LEVEL = 'fatal';
