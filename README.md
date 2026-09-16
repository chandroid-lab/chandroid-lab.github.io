Personal website, based on the template from [Jon Barron's academic site](https://github.com/jonbarron/jonbarron.github.io).

The Spot + Arm model in the playground (`models/spot.bin`) is baked by `tools/build_spot.py` from the
[RAI Institute spot_description](https://github.com/rai-opensource/spot_description) meshes
(MIT / BSD-3-Clause, see `models/spot-LICENSE.txt`). Every link behind a revolute joint is exported in
its own frame, along with the joint chain, limits and foot contact points.

There are two robots: Spot takes the orders, and Echo keeps a place relative to it (alongside,
following, or off scouting a prop). A phrase can be several steps ("walk to the crates, stop, then
wave"), and naming a place ("warehouse", "rubble", "forest") changes the props on the ground, which
`field-site.js` lays out and the fog shader ray-tests. The change happens behind the fog: it closes
over everything but the robots, the view cuts to Echo's arm camera on Spot, and it lifts on the new
place.

Typing a phrase in the playground walks the robot. `spot-gait.js` turns the text into a locomotion
command (gait, speed, turn rate, body height, step height, and what the arm should be doing), then
runs a phase-based gait generator:
each foot is placed on the ground along the arc the body is actually travelling, and a closed-form
two-link IK solves the leg for it. Nothing leaves the browser — there is no model and no server call.

The faint circle in the corner of the canvas switches to the camera on the end of Echo's arm: the page
asks the renderer where the wrist link ended up and rides that frame, roll included. With no orders
for the arm, Echo holds the camera level and keeps it on Spot; tell Echo to swing or wave and the view
goes along for the ride, which is the point. Esc comes back.
