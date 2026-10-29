// Mobile manipulator · 419mm reach on a 130mm 4WD base — Rigforge export
// Rest pose, mm. Edit the numbers, or $fn for smoother cylinders.
$fn = 48;

translate([0.0, 0.0, 135.0]) cube([389.0, 338.0, 3.0], center=true); // deck
translate([-108.9, 0.0, 125.0]) cube([10.0, 326.0, 16.0], center=true); // deck-rib--0.28
translate([46.7, 0.0, 125.0]) cube([10.0, 326.0, 16.0], center=true); // deck-rib-0.12
translate([0.0, -171.0, 99.0]) cube([397.0, 4.0, 40.0], center=true); // rail-r
translate([0.0, 171.0, 99.0]) cube([397.0, 4.0, 40.0], center=true); // rail-l
translate([-190.5, 0.0, 95.0]) cube([4.0, 338.0, 50.0], center=true); // bulkhead-b
translate([190.5, 0.0, 95.0]) cube([4.0, 338.0, 50.0], center=true); // bulkhead-f
translate([62.2, 0.0, 151.0]) cube([108.9, 142.0, 28.0], center=true); // pack-box
translate([-23.3, -87.9, 147.0]) cube([85.6, 101.4, 20.0], center=true); // avionics
rotate([0, 90, 0]) translate([208.5, 0.0, 83.0]) cylinder(h=34.0, r=14.0, center=true); // bumper
rotate([90, 0, 0]) translate([186.5, 185.0, 65.0]) cylinder(h=30.0, r=65.0, center=true); // wheel-0
rotate([90, 0, 0]) translate([186.5, 187.0, 65.0]) cylinder(h=34.0, r=31.2, center=true); // hub-0
rotate([90, 0, 0]) translate([186.5, 143.0, 65.0]) cylinder(h=46.0, r=19.0, center=true); // motor-0
rotate([90, 0, 0]) translate([186.5, -185.0, 65.0]) cylinder(h=30.0, r=65.0, center=true); // wheel-1
rotate([90, 0, 0]) translate([186.5, -187.0, 65.0]) cylinder(h=34.0, r=31.2, center=true); // hub-1
rotate([90, 0, 0]) translate([186.5, -143.0, 65.0]) cylinder(h=46.0, r=19.0, center=true); // motor-1
rotate([90, 0, 0]) translate([-186.5, 185.0, 65.0]) cylinder(h=30.0, r=65.0, center=true); // wheel-2
rotate([90, 0, 0]) translate([-186.5, 187.0, 65.0]) cylinder(h=34.0, r=31.2, center=true); // hub-2
rotate([90, 0, 0]) translate([-186.5, 143.0, 65.0]) cylinder(h=46.0, r=19.0, center=true); // motor-2
rotate([90, 0, 0]) translate([-186.5, -185.0, 65.0]) cylinder(h=30.0, r=65.0, center=true); // wheel-3
rotate([90, 0, 0]) translate([-186.5, -187.0, 65.0]) cylinder(h=34.0, r=31.2, center=true); // hub-3
rotate([90, 0, 0]) translate([-186.5, -143.0, 65.0]) cylinder(h=46.0, r=19.0, center=true); // motor-3
translate([-70.0, 0.0, 191.0]) cylinder(h=108.0, r=46.0, center=true); // turret
translate([-70.0, 0.0, 245.0]) cylinder(h=10.0, r=26.0, center=true); // turret-bearing
translate([-62.0, 0.0, 261.0]) cube([54.0, 62.0, 50.0], center=true); // shoulder-block
rotate([90, 0, 0]) translate([-70.0, 0.0, 245.0]) cylinder(h=72.0, r=20.0, center=true); // shoulder-hub
translate([29.0, 0.0, 245.0]) cube([198.0, 48.0, 42.0], center=true); // upper-arm
translate([29.0, 0.0, 269.0]) cube([158.4, 10.0, 6.0], center=true); // upper-rib
rotate([90, 0, 0]) translate([128.0, 0.0, 245.0]) cylinder(h=56.0, r=17.0, center=true); // elbow-hub
translate([209.0, 0.0, 245.0]) cube([162.0, 42.0, 38.0], center=true); // forearm
rotate([90, 0, 0]) translate([290.0, 0.0, 245.0]) cylinder(h=48.0, r=15.0, center=true); // wrist-hub
translate([319.2, 0.0, 245.0]) cube([58.5, 34.0, 30.0], center=true); // wrist-link
translate([366.5, 0.0, 245.0]) cube([36.0, 52.0, 40.0], center=true); // gripper-body
translate([393.5, -16.0, 245.0]) cube([26.0, 8.0, 32.0], center=true); // jaw-a
translate([393.5, 16.0, 245.0]) cube([26.0, 8.0, 32.0], center=true); // jaw-b
translate([196.5, 0.0, 159.0]) cube([26.0, 26.0, 44.0], center=true); // head-neck
translate([196.5, 0.0, 196.0]) cube([62.0, 74.0, 30.0], center=true); // head
rotate([0, 90, 0]) translate([228.5, -14.0, 195.0]) cylinder(h=8.0, r=9.0, center=true); // tof
rotate([0, 90, 0]) translate([228.5, 16.0, 199.0]) cylinder(h=8.0, r=8.0, center=true); // cam