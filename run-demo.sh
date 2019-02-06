#! /bin/bash

#sudo sysctl -w net.inet.udp.maxdgram=65535

gtimeout -v -k 3 --foreground 200 npx aegir test -t node -f test/collaboration-random.spec.js

