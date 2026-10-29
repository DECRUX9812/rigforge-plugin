// 550mm humanoid · 23 joints — Rigforge export
// Rest pose, mm. Edit the numbers, or $fn for smoother cylinders.
$fn = 48;

translate([0.0, 0.0, 301.4]) cube([93.5, 53.6, 41.3], center=true); // pelvis
translate([0.0, 0.0, 397.6]) cube([115.5, 59.6, 135.0], center=true); // torso
translate([0.0, 31.8, 410.7]) cube([99.3, 14.0, 71.5], center=true); // chest-plate
translate([0.0, -33.8, 400.7]) cube([69.3, 22.0, 57.2], center=true); // pack
translate([0.0, 0.0, 481.1]) cylinder(h=18.0, r=13.0, center=true); // neck
translate([0.0, 0.0, 518.7]) cube([60.1, 55.7, 63.3], center=true); // head
translate([0.0, 28.5, 521.7]) cube([39.2, 6.0, 20.2], center=true); // visor
rotate([0, 90, 0]) translate([39.6, 0.0, 280.8]) cylinder(h=43.0, r=18.0, center=true); // hip-hub-l
translate([39.6, 0.0, 210.2]) cube([33.0, 39.6, 117.3], center=true); // thigh-l
rotate([0, 90, 0]) translate([39.6, 0.0, 151.6]) cylinder(h=39.0, r=15.0, center=true); // knee-hub-l
translate([39.6, 0.0, 82.7]) cube([28.4, 35.6, 109.8], center=true); // shin-l
translate([39.6, 17.8, 89.7]) cube([16.5, 8.0, 86.6], center=true); // shin-rib-l
rotate([0, 90, 0]) translate([39.6, 0.0, 27.8]) cylinder(h=26.4, r=12.0, center=true); // ankle-hub-l
translate([39.6, 22.4, 9.9]) cube([46.8, 101.8, 19.8], center=true); // foot-l
translate([39.6, 22.4, 2.5]) cube([43.0, 95.6, 5.0], center=true); // sole-l
rotate([0, 90, 0]) translate([-39.6, 0.0, 280.8]) cylinder(h=43.0, r=18.0, center=true); // hip-hub-r
translate([-39.6, 0.0, 210.2]) cube([33.0, 39.6, 117.3], center=true); // thigh-r
rotate([0, 90, 0]) translate([-39.6, 0.0, 151.6]) cylinder(h=39.0, r=15.0, center=true); // knee-hub-r
translate([-39.6, 0.0, 82.7]) cube([28.4, 35.6, 109.8], center=true); // shin-r
translate([-39.6, 17.8, 89.7]) cube([16.5, 8.0, 86.6], center=true); // shin-rib-r
rotate([0, 90, 0]) translate([-39.6, 0.0, 27.8]) cylinder(h=26.4, r=12.0, center=true); // ankle-hub-r
translate([-39.6, 22.4, 9.9]) cube([46.8, 101.8, 19.8], center=true); // foot-r
translate([-39.6, 22.4, 2.5]) cube([43.0, 95.6, 5.0], center=true); // sole-r
rotate([0, 90, 0]) translate([80.3, 0.0, 447.9]) cylinder(h=33.0, r=16.0, center=true); // shoulder-hub-l
translate([80.3, 0.0, 394.8]) cube([29.7, 34.1, 86.3], center=true); // upperarm-l
rotate([0, 90, 0]) translate([80.3, 0.0, 351.6]) cylinder(h=28.1, r=13.0, center=true); // elbow-hub-l
translate([80.3, 0.0, 302.6]) cube([25.7, 29.7, 78.0], center=true); // forearm-l
translate([80.3, 0.0, 245.9]) cube([23.1, 23.8, 27.5], center=true); // hand-l
rotate([0, 90, 0]) translate([-80.3, 0.0, 447.9]) cylinder(h=33.0, r=16.0, center=true); // shoulder-hub-r
translate([-80.3, 0.0, 394.8]) cube([29.7, 34.1, 86.3], center=true); // upperarm-r
rotate([0, 90, 0]) translate([-80.3, 0.0, 351.6]) cylinder(h=28.1, r=13.0, center=true); // elbow-hub-r
translate([-80.3, 0.0, 302.6]) cube([25.7, 29.7, 78.0], center=true); // forearm-r
translate([-80.3, 0.0, 245.9]) cube([23.1, 23.8, 27.5], center=true); // hand-r