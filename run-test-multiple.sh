#! /bin/bash

for i in `seq 1 10`; do
  echo "Test Run $i"
  ./run-demo.sh
  echo
done
