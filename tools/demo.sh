#!/bin/sh
# HackyTab demo launcher (wrapper). See tools/demo.pl for details and options.
exec perl "$(dirname "$0")/demo.pl" "$@"
