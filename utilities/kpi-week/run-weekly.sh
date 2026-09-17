#!/bin/sh
set -e
START=$(date -d "-$(( $(date +%u) + 6 )) days" +%F)
END=$(date -d "-$(date +%u) days" +%F)
echo "# window: $START .. $END"
exec /usr/bin/python3 /opt/weekly-kpi/kpi-week.py "$START" "$END" --csv "/opt/weekly-kpi/out/kpi-$START.csv"