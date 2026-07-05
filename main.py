from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from fastapi.middleware.gzip import GZipMiddleware  # 🚀 Step 2: Import Gzip middleware

app = FastAPI(title="CS2 Tactical Analytics API")

'''
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
'''

app.add_middleware(GZipMiddleware, minimum_size=500)  # 🚀 Step 3: Add Gzip middleware

client = MongoClient("mongodb://localhost:27017/")
db = client["cs2_database"]

MAP_RADAR_PROPERTIES = {
    "de_mirage": {"pos_x": -3230, "pos_y": 1713, "scale": 5.0},
    "de_inferno": {"pos_x": -2087, "pos_y": 3870, "scale": 4.9},
    "de_nuke": {"pos_x": -3453, "pos_y": 2887, "scale": 7.0},
    "de_ancient": {"pos_x": -2953, "pos_y": 2164, "scale": 5.0},
    "de_anubis": {"pos_x": -2796, "pos_y": 3328, "scale": 5.22},
    "de_overpass": {"pos_x": -4831, "pos_y": 1781, "scale": 5.2},
    "de_dust2": {"pos_x": -2476, "pos_y": 3239, "scale": 4.4}
}

# 1. Populates your filter dropdowns instantly from the registry
@app.get("/api/filters")
async def get_filters():
    players_cursor = db.players.find({}, {"name": 1, "_id": 1})
    player_list = [{"steamid": p["_id"], "name": p["name"]} for p in players_cursor]
    
    unique_maps = db.player_matches.distinct("map_name")
    
    return {
        "players": sorted(player_list, key=lambda x: x["name"]),
        "maps": sorted(unique_maps)
    }

# 2. Handles the custom tactical overlay query
@app.get("/api/query")
async def query_trajectories(
    steamid: str = Query(...),
    side: str = Query(...),
    map_name: str = Query(...)
):
    clean_steamid = int(steamid)
    is_global_query = (map_name == "all" or not map_name or map_name.strip() == "")
    side_lower = side.lower()

    # --- 1. DEFINE BASELINE MATCH STAGE ---
    match_filter = {"steamid": clean_steamid}
    if not is_global_query:
        match_filter["map_name"] = map_name

    # --- 2. INITIALIZE PIPELINE WITH SORT ---
    pipeline = [
        {"$match": match_filter},
        {"$sort": {"date_played": -1}}
    ]

    # --- 3. HANDLE CEILING LIMIT ENFORCEMENT ($slice top 5 per map) ---
    if is_global_query:
        pipeline.extend([
            {"$group": {
                "_id": "$map_name",
                "docs": {"$push": "$$ROOT"}
            }},
            {"$project": {
                "docs": {"$slice": ["$docs", 5]}
            }},
            {"$unwind": "$docs"},
            {"$replaceRoot": {"newRoot": "$docs"}}
        ])
    else:
        pipeline.append({"$limit": 5})

    # --- 4. JOIN WITH MATCH_DATA AND EXTRACT TARGETED RECORDS ---
    pipeline.extend([
        {
            "$lookup": {
                "from": "match_data",
                "localField": "match_doc_id",
                "foreignField": "_id",
                "as": "match"
            }
        },
        {"$unwind": "$match"},
        {
            "$project": {
                "map_name": "$map_name",
                # Extract and filter down trajectories instantly inside the DB engine
                "trajectories": {
                    "$filter": {
                        "input": "$match.trajectories",
                        "as": "t",
                        "cond": {
                            "$and": [
                                {"$eq": [{"$toString": "$$t.steamid"}, str(steamid)]},
                                {"$or": [
                                    {"$eq": [side_lower, "all"]},
                                    {"$eq": [{"$toLower": "$$t.side"}, side_lower]}
                                ]}
                            ]
                        }
                    }
                },
                # Pull the raw grenade list along for downstream validation setup
                "raw_grenades": "$match.grenades"
            }
        }
    ])

    # Run the aggregation pipeline
    aggregated_matches = list(db.player_matches.aggregate(pipeline))

    if not aggregated_matches:
        return {
            "map_name": map_name, 
            "radar_config": MAP_RADAR_PROPERTIES.get(map_name, MAP_RADAR_PROPERTIES["de_mirage"]),
            "trajectories": [], 
            "grenades": []
        }

    # --- 5. SURFACE CORRELATION FOR GRENADES ---
    final_trajectories = []
    final_grenades = []

    for doc in aggregated_matches:
        associated_map = doc.get("map_name", "de_mirage")
        allowed_rounds = set()
        target_steamids = set()

        # Reshape lean trajectory documents for delivery
        for traj in doc.get("trajectories", []):
            final_trajectories.append({
                "round_num": traj["round_num"],
                "side": traj["side"].lower(),
                "coords": traj["coords"],
                "map_name": associated_map
            })
            allowed_rounds.add(traj["round_num"])
            if traj.get("steamid"):
                target_steamids.add(str(traj["steamid"]))

        # Correlate grenades quickly via hash lookups using local filtered structures
        for nade in doc.get("raw_grenades", []):
            nade_thrower_id = str(nade.get("thrower_id"))

            if nade.get("round_num") in allowed_rounds and nade_thrower_id in target_steamids:
                if side_lower == "all" or nade.get("side", "").lower() == side_lower:
                    final_grenades.append({
                        "round_num": nade["round_num"],
                        "type": nade["type"],
                        "path": nade["path"],
                        "map_name": associated_map,
                        "side": nade.get("side", "").lower(),
                        "thrower_id": nade.get("thrower_id", ""),
                        "entity_id": nade.get("entity_id", 0)
                    })

    # --- 6. ASSEMBLE AND STREAM VIA THE MODERN SERIALIZATION ENGINE ---
    available_maps = list({t["map_name"] for t in final_trajectories})
    return {
        "map_name": map_name,
        "available_maps": available_maps,
        "trajectories": final_trajectories,
        "grenades": final_grenades
    }
