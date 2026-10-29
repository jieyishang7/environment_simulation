# Environment Simulation: Central Park

A single-page web app, written in vanilla JavaScript with three.js, that visualizes a semantic model of a park. The model has lawns, paths, benches and users (people and dogs), the relationships between them, and the rules they must follow.

## Run

The app uses ES modules, so serve the folder over HTTP instead of opening the file directly:

```sh
npx http-server -c-1 .     # or: python3 -m http.server
```

Then open http://localhost:8080 (or :8000). three.js is loaded from the jsDelivr CDN.

## Map

The park is the real Central Park. `data/central-park.geojson` is a vendored extract of OpenStreetMap: the park outline, 11 named lawns (Sheep Meadow, Great Lawn, East Meadow, North Meadow, Cedar Hill and others), every footpath (split at junctions so walkers follow the real network), water, woods, and the streets and buildings about one block around the park. The app never calls a map API. To refresh the extract, run `python3 scripts/build_central_park.py` (needs `shapely`). Lawns are the OSM outlines with the paths that cross them cut out. The map is drawn in feet, rotated so the Manhattan grid is square to the screen. Map data © OpenStreetMap contributors, ODbL.

## Files

| File | Role |
| --- | --- |
| `js/map.js` | Loads the GeoJSON extract and projects it to feet. |
| `js/model.js` | The semantic model: entities, relationships, rules, actions. Has no rendering code. |
| `js/distance.js` | The two distance metrics: the walking network, park gates, Dijkstra. Has no rendering code. |
| `js/distance-ui.js` | The Distance panel: bars, scatter, near/far list, map overlay, Measure tool. |
| `js/geometry.js` | Polygon helpers: area, containment, overlap, shared edges. |
| `js/view.js` | three.js scene: lawns, paths, users, fences, labels, animation. |
| `js/main.js` | Toolbar, selection, inspector, rule checklist, event log. |

## Model

- **Lawn**: grass height (2–20″), boundary polygon, area (from the boundary), status (open/closed).
- **Path**: width (ft) and boundary polygon. The boundary is swept from a centerline.
- **Bench**: 3 seats, standing just off a path and facing it.
- **User**: a person or a dog. Position (x, y), activity (walking/standing/sitting, plus playing for dogs), location (a path, lawn or bench). A dog has an owner and is on or off its leash.

Relationships are derived from geometry. A path *borders* a lawn, and *connects to* another path, when their boundaries share an edge segment.

The **Rules** panel checks every rule after each action. Actions enforce the rules:

- Users can enter a lawn only if it is open and holds fewer than ⌊area ÷ 10 ft²⌋ users. Dogs count as users.
- People stand on lawns and sit on lawns or benches. Only people sit on benches, at most 3 per bench.
- A leashed dog stays within 6 ft of its owner and does what they do. An unleashed dog must be on a lawn with its owner. Only unleashed dogs play.
- A walking user who changes activity steps onto the nearest bordering lawn that allows it, and stands. A sitting user who changes activity moves to the nearest path and walks.
- Sit on bench moves a person to the nearest bench with a free seat. Their dogs lie on the path at their feet.
- Add dog gives the selected person a leashed dog, or brings a new visitor with a dog. Unleash works only when the owner is on a lawn. Fetch has the owner throw a ball for an unleashed dog.
- Mowing (to 5″) is refused while anyone is on the lawn. Clear lawn sends everyone on it (people and their dogs) to the nearest path, so it can then be mowed.
- Closing a lawn moves its users to the nearest path, where they walk.
- Advancing time moves walkers along the path network (turning at junctions) and grows grass, up to 20″.

## Distance

Two forms of distance (metrics) between any two places in the park, and so, by where they stand, between any two occupants:

- **Straight line**: Euclidean distance, as the crow flies. It ignores water, woods, fences and buildings.
- **On foot**: the shortest walk along the real footpaths, cutting straight across any **open** lawn. Closed lawns are fenced, so the walk goes around them. This is a network distance computed with Dijkstra's algorithm, so it follows complex paths, not just a line of sight (the bonus).
- **Paths only** is shown alongside as a reference: the same walk without lawn shortcuts. The gap between it and *on foot* is what the open lawns save.

The walking network is built once from the map. Every path vertex is a node, with extra nodes every 40 ft on long segments, about 14,000 nodes. Each lawn adds straight edges between the path points around its edge, about 5,800 edges in all, tagged with the lawn so they switch off when it closes. Where a path crosses the park outline there is an exit node. Exit nodes within 220 ft of each other are one **gate**, named after the cross street it lines up with (for example *CPW & W 81st St*), giving 48 gates. A query runs in a few milliseconds, so every number updates live as people walk, lawns close and time advances.

**Questions it answers.** Select a person, dog or bench, and the Distance panel shows:

- **Nearest exit**: the closest gate by straight line, and the closest gate on foot.
- **Next open lawn**: the closest lawn by straight line (which may be closed), and the closest open lawn on foot.
- **A → B**: press **Measure** (`G`), then click a person or any spot. With nothing selected, Measure takes two clicks: A, then B.

**Visualization and comparison.**

- On the map, a blue dashed line is the straight line, an orange ribbon is the walking route, a green ribbon is the paths-only route, and black dots are gates.
- In the panel, bars compare the three distances for each question, each with walking time at about 3 mph.
- A scatter plots every gate and lawn by straight line (x) against on foot (y) on equal scales. The diagonal means "no detour". Points in the shaded wedge are at least 1.5× farther on foot. Click a point to measure to it.
- A map overlay colors every path by on-foot distance from A, or by detour (on foot ÷ straight line).

**Near by one metric, far by the other.** The panel flags each case it finds:

- The closest gate in a straight line isn't the closest on foot.
- The closest lawn in a straight line is closed, so the walk goes on to another lawn.
- A place's walk is at least 1.5× its straight line.
- A place's rank jumps between the two metrics, for example *4th closest in a straight line but 11th on foot*.

The **Detour** overlay shows where this happens across the whole park: paths across the Reservoir, the Lake and the Ramble light up.

Examples to try:
- Select Visitor 7, sitting on the Great Lawn. Cedar Hill is the closest lawn in a straight line (852 ft), but it is closed, so the nearest open lawn on foot is Pilgrim Hill (2,608 ft). Close Pilgrim Hill too, and the walk moves on to East Green.
- Measure across the Reservoir, from the west side of the running track to the east side. The straight line is 2,232 ft and the walk is 3,988 ft (1.8×).

![Closed lawn: near in a straight line, far on foot](docs/distance-closed-lawn.png)
![Across the Reservoir, with the detour overlay](docs/distance-reservoir.png)

## Example scene

The camera starts at the south end of the Great Lawn, by Turtle Pond. Sheep Meadow starts at 17″ and needs mowing; Cedar Hill starts closed. Eleven people: 6 walking (one with a leashed dog), 3 sitting on the Great Lawn (one with a dog playing off leash), 1 standing and 1 sitting on a bench. Benches line the paths beside each lawn. Add user brings a visitor onto a path near where the camera is looking. Zoom out to see the whole park and its street grid.

Visual encoding:
- Grass color runs from light green (short) to dark green (tall), and the grass tufts grow taller.
- A lawn that needs mowing has a pulsing amber dashed outline and a badge.
- A closed lawn has a fence and red hatching.
- Users are colored by activity: blue for walking, orange for standing, purple for sitting, pink for playing. People's bodies take the color. Dogs show it on their collar and on a disk under them, and a red line marks a leash.
- Bench labels show seats taken, for example `1/3`.

Click to select. Drag to orbit, scroll to zoom. Keyboard: `G` measure, `A` add, `Del` remove, `C` activity, `B` bench, `D` dog, `L` leash, `F` fetch, `T` advance, `P` play, `X` clear lawn, `M` mow, `O` open/close, `Esc` deselect. The model is exposed as `window.parkApp` for poking at it from the console.
