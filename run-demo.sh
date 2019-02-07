#! /bin/bash

#sudo sysctl -w net.inet.udp.maxdgram=65535

#gtimeout -v -k 3 --foreground 200 npx aegir test -t node -f test/collaboration-random.spec.js
#gtimeout -v -k 3 --foreground 200 ./node_modules/.bin/mocha test/collaboration-random.spec.js

function cleanup {
  echo 'Cleaning up...'
  kill $PID 2> /dev/null
  wait $PID
  if [ "`whoami`" = "test1" ]; then
    if pgrep -U $UID node; then
      # desparate hack
      killall -9 -v node
    fi
  fi
  echo "Done."
}

trap cleanup SIGINT

gtimeout -v -k 3 260 npx aegir test -t node -f test/collaboration-random.spec.js &
PID=$!
echo PID: $PID
wait $PID
cleanup

