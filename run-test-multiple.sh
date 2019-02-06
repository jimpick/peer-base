#! /bin/bash

NUM=$1
if [ -z "$NUM" ]; then
  echo "Usage: $0 <num>"
  exit 1
fi

mkdir -p test/results
OUTPUT=test/results/`date -u "+%Y%m%d_%H_%M_%S"`.txt

(
  function finish {
    echo "Cleaning up..."
    kill $PID
    wait $PID
    rm $PIDFILE > /dev/null 2>&1 &
    sleep 1
  }

  #trap finish EXIT
  #trap "exit 2; finish" SIGINT

  PIDFILE=/tmp/rendezvous-tracing.pid

  echo Starting Rendezvous
  if [ -f $PIDFILE ]; then
    echo "Rendezvous server is already running, PID: $(< $PIDFILE)"
    exit 1
  else
    echo
    #npx rendezvous &
    #PID=$!
    #echo $PID > $PIDFILE
  fi

  for i in `seq 1 $NUM`; do
    echo "Test Run $i of $NUM"
    ./run-demo.sh
    sleep 2
    echo
  done
) 2>&1 | tee $OUTPUT

