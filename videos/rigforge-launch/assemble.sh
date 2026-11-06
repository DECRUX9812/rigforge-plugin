#!/bin/bash
# RigForge launch cut — beats from the raw screen capture, <90s.
set -e
SRC=/home/decrux/.cache/devin/scratch/rigforge-demo/page@5890ec913a989214fce02a9960414359.webm
OUT=/home/decrux/Code/rigforge-plugin/videos/rigforge-launch
FONT=/home/decrux/.local/share/fonts/JetBrainsMonoNL-SemiBold.ttf
FPS=25
W=1440; H=810

# normalize one segment: trim [in,out), optional speed, fps/format
seg() { # name in out speed
  local name=$1 in=$2 out=$3 spd=${4:-1}
  ffmpeg -v error -ss "$in" -to "$out" -i "$SRC" \
    -vf "setpts=PTS/$spd,fps=$FPS,scale=$W:$H,format=yuv420p" \
    -an -c:v libx264 -preset fast -crf 20 -y "$OUT/render/$name.mp4"
}

seg 01-build   8   19  1
seg 02-bench   22  33  1
seg 03a-auto   53  69  1.5
seg 03b-cert   66  72  1
seg 04-break   73  83  1
seg 05-fix     86  97  1
seg 06-gantry  106 116 1
seg 07-custom  122 127 1
seg 08-editor  129 133 1
seg 09-export  136 141 1

# outro card — the whole loop in one line
ffmpeg -v error -f lavfi -i "color=c=0x0a0d10:s=${W}x${H}:d=3:r=$FPS" \
  -vf "drawtext=fontfile=$FONT:text='RIGFORGE':fontcolor=0xFF8A3D:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2-60,\
drawtext=fontfile=$FONT:text='Build - Drive - Break - Fix - Export':fontcolor=0xE8ECF1:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+30,\
drawtext=fontfile=$FONT:text='github.com/DECRUX9812/rigforge-plugin  -  @NousResearch':fontcolor=0x8A93A3:fontsize=20:x=(w-text_w)/2:y=(h+text_h)/2+40" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -y "$OUT/render/10-outro.mp4"

# concat list
: > $OUT/render/list.txt
for f in $(ls $OUT/render/*.mp4 | sort); do echo "file '$f'" >> $OUT/render/list.txt; done
ffmpeg -v error -f concat -safe 0 -i $OUT/render/list.txt -c copy -y $OUT/renders/raw-cut.mp4

# captions + intro title, timed to the cut
# segment starts: 0,11,22,32.7,38.7,48.7,59.7,69.7,74.7,78.7,83.7(outro)
ffmpeg -v error -i $OUT/renders/raw-cut.mp4 \
  -vf "\
drawtext=fontfile=$FONT:text='RIGFORGE':fontcolor=0xFF8A3D:fontsize=58:x=(w-text_w)/2:y=180:enable='between(t,0.6,4.2)',\
drawtext=fontfile=$FONT:text='printed-machine design studio':fontcolor=0x8A93A3:fontsize=24:x=(w-text_w)/2:y=255:enable='between(t,0.6,4.2)',\
drawtext=fontfile=$FONT:text='01 / BUILD':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,0.8,10.6)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='one sentence becomes an engineered machine':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,0.8,10.6)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='02 / BENCH + DRIVE':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,11.4,21.4)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='CoM, support polygon, torque margins - then W drives':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,11.4,21.4)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='03 / CERTIFY':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,22.4,38.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='AUTO scores every leg live - 6/6 on the rack':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,22.4,38.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='04 / BREAK':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,39.0,48.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='porch stairs\: 80mm risers beat 100mm wheels - honest fail':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,39.0,48.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='05 / FIX':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,49.0,59.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='the bench prescribes - APPLY FIX rebuilds at 150mm':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,49.0,59.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='06 / RANGE':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,60.0,69.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='gantry\: three chained slide axes, WASD + quill':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,60.0,69.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='07-08 / AUTHOR':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,70.0,78.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='custom machine - the nodes/joints spec IS the design':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,70.0,78.2)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='09 / EXPORT':fontcolor=0x00E5FF:fontsize=22:x=34:y=748:enable='between(t,78.8,82.3)':box=1:boxcolor=black@0.5:boxborderw=8,\
drawtext=fontfile=$FONT:text='STL 3MF GLB STEP URDF spec.md firmware - one click':fontcolor=0xE8ECF1:fontsize=20:x=34:y=780:enable='between(t,78.8,82.3)':box=1:boxcolor=black@0.5:boxborderw=8" \
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart -y $OUT/renders/video.mp4

ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 $OUT/renders/video.mp4
