from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from fastapi.middleware.gzip import GZipMiddleware  # 🚀 Step 2: Import Gzip middleware
import os
from dotenv import load_dotenv
load_dotenv()
app = FastAPI(title="CS2 Tactical Analytics API")

#example .env
'''
# .env
DB_URL=mongodb://localhost:27017/
ALLOW_ORIGINS=*
ALLOW_METHODS=GET
DB_NAME=cs2_database
'''

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("ALLOW_ORIGINS"), ""],
    allow_credentials=True,
    allow_methods=[os.getenv("ALLOW_METHODS"), ""],
    allow_headers=["*"],
)


app.add_middleware(GZipMiddleware, minimum_size=500)  # 🚀 Step 3: Add Gzip middleware

client = MongoClient(os.getenv("DB_URL"))
db = client[os.getenv("DB_NAME")]

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
    players_cursor = db.visualizer_ready_data.find({}, {"name": 1, "_id": 1})
    player_list = [{"steamid": str(p["_id"]), "name": p["name"]} for p in players_cursor]
    
    unique_maps = db.player_matches.distinct("map_name")
    
    return {
        "players": sorted(player_list, key=lambda x: x["name"]),
        "maps": sorted(unique_maps)
    }

# 2. Handles the custom tactical overlay query
# Define the current Active Duty map pool based on your configuration parameters
ACTIVE_DUTY_POOL = {
    "de_mirage", "de_inferno", "de_nuke", "de_ancient", 
    "de_anubis", "de_dust2", "de_overpass"
}

@app.get("/api/query")
async def query_trajectories(
    steamid: str = Query(...),
    side: str = Query(...)
):
    clean_steamid = int(steamid)
    side_lower = side.lower()

    # 1. Fetch the entire player profile document
    player_profile = db.visualizer_ready_data.find_one({"_id": clean_steamid})

    if not player_profile or "maps" not in player_profile:
        return {
            "available_maps": [],
            "maps": {}
        }

    maps_dict = player_profile["maps"]
    
    # Filter available maps to ONLY include those in the Active Duty Pool
    available_maps = sorted([m for m in maps_dict.keys() if m in ACTIVE_DUTY_POOL])

    final_maps_payload = {}
    
    for map_name in available_maps:
        map_data = maps_dict[map_name]
        raw_trajectories = map_data.get("trajectories", [])
        raw_grenades = map_data.get("grenades", [])

        # --- 2. CEILING LIMIT ENFORCEMENT: ISOLATE TOP 5 LATEST MATCHES ---
        # Map each unique match_id to its respective date_played timestamp
        match_dates = {}
        for traj in raw_trajectories:
            m_id = traj.get("match_id")
            d_played = traj.get("date_played")
            if m_id and d_played:
                # Keep track of the latest date seen for this match
                if m_id not in match_dates or d_played > match_dates[m_id]:
                    match_dates[m_id] = d_played

        # Sort matches by date descending and take the top 5 most recent IDs
        latest_5_matches = set(
            sorted(match_dates, key=match_dates.get, reverse=True)[:5]
        )

        # --- 3. FILTER ARRAYS DOWN TO THE TOP 5 MATCHES & SIDE CONTEXT ---
        trajectories = [
            t for t in raw_trajectories 
            if t.get("match_id") in latest_5_matches and 
            (side_lower == "all" or t.get("side") == side_lower)
        ]
        
        grenades = [
            g for g in raw_grenades 
            if g.get("match_id") in latest_5_matches and 
            (side_lower == "all" or g.get("side") == side_lower)
        ]

        # Sort final trajectory lines for the renderer UI timeline
        trajectories.sort(key=lambda x: x.get("date_played", ""), reverse=True)

        final_maps_payload[map_name] = {
            "trajectories": trajectories,
            "grenades": grenades
        }

    return {
        "available_maps": available_maps,
        "maps": final_maps_payload
    }