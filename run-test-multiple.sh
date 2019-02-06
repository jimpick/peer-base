#! /bin/bash

NUM=$1
if [ -z "$NUM" ]; then
  echo "Usage: $0 <num>"
  exit 1
fi

for i in `seq 1 $NUM`; do
  echo "Test Run $i of $NUM"
  ./run-demo.sh
  echo
done
