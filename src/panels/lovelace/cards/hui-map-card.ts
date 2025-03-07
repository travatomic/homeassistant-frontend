import { HassEntities, HassEntity } from "home-assistant-js-websocket";
import { LatLngTuple } from "leaflet";
import {
  css,
  CSSResultGroup,
  html,
  LitElement,
  PropertyValues,
  TemplateResult,
} from "lit";
import { customElement, property, query, state } from "lit/decorators";
import { mdiImageFilterCenterFocus } from "@mdi/js";
import memoizeOne from "memoize-one";
import { computeDomain } from "../../../common/entity/compute_domain";
import parseAspectRatio from "../../../common/util/parse-aspect-ratio";
import "../../../components/ha-card";
import "../../../components/ha-icon-button";
import { fetchRecent } from "../../../data/history";
import { HomeAssistant } from "../../../types";
import { findEntities } from "../common/find-entities";
import { processConfigEntities } from "../common/process-config-entities";
import { EntityConfig } from "../entity-rows/types";
import { LovelaceCard } from "../types";
import { MapCardConfig } from "./types";
import "../../../components/map/ha-map";
import type { HaMap, HaMapPaths } from "../../../components/map/ha-map";
import { getColorByIndex } from "../../../common/color/colors";

const MINUTE = 60000;

@customElement("hui-map-card")
class HuiMapCard extends LitElement implements LovelaceCard {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ type: Boolean, reflect: true })
  public isPanel = false;

  @state()
  private _history?: HassEntity[][];

  @state()
  private _config?: MapCardConfig;

  @query("ha-map")
  private _map?: HaMap;

  private _date?: Date;

  private _configEntities?: string[];

  private _colorDict: Record<string, string> = {};

  private _colorIndex = 0;

  public setConfig(config: MapCardConfig): void {
    if (!config) {
      throw new Error("Error in card configuration.");
    }

    if (!config.entities?.length && !config.geo_location_sources) {
      throw new Error(
        "Either entities or geo_location_sources must be specified"
      );
    }
    if (config.entities && !Array.isArray(config.entities)) {
      throw new Error("Entities need to be an array");
    }
    if (
      config.geo_location_sources &&
      !Array.isArray(config.geo_location_sources)
    ) {
      throw new Error("Geo_location_sources needs to be an array");
    }

    this._config = config;
    this._configEntities = (
      config.entities
        ? processConfigEntities<EntityConfig>(config.entities)
        : []
    ).map((entity) => entity.entity);

    this._cleanupHistory();
  }

  public getCardSize(): number {
    if (!this._config?.aspect_ratio) {
      return 7;
    }

    const ratio = parseAspectRatio(this._config.aspect_ratio);
    const ar =
      ratio && ratio.w > 0 && ratio.h > 0
        ? `${((100 * ratio.h) / ratio.w).toFixed(2)}`
        : "100";
    return 1 + Math.floor(Number(ar) / 25) || 3;
  }

  public static async getConfigElement() {
    await import("../editor/config-elements/hui-map-card-editor");
    return document.createElement("hui-map-card-editor");
  }

  public static getStubConfig(
    hass: HomeAssistant,
    entities: string[],
    entitiesFallback: string[]
  ): MapCardConfig {
    const includeDomains = ["device_tracker"];
    const maxEntities = 2;
    const foundEntities = findEntities(
      hass,
      maxEntities,
      entities,
      entitiesFallback,
      includeDomains
    );

    return { type: "map", entities: foundEntities };
  }

  protected render(): TemplateResult {
    if (!this._config) {
      return html``;
    }
    return html`
      <ha-card id="card" .header=${this._config.title}>
        <div id="root">
          <ha-map
            .hass=${this.hass}
            .entities=${this._getEntities(
              this.hass.states,
              this._config,
              this._configEntities
            )}
            .zoom=${this._config.default_zoom ?? 14}
            .paths=${this._getHistoryPaths(this._config, this._history)}
            .autoFit=${this._config.auto_fit}
            .darkMode=${this._config.dark_mode}
          ></ha-map>
          <ha-icon-button
            .label=${this.hass!.localize(
              "ui.panel.lovelace.cards.map.reset_focus"
            )}
            .path=${mdiImageFilterCenterFocus}
            @click=${this._fitMap}
            tabindex="0"
          ></ha-icon-button>
        </div>
      </ha-card>
    `;
  }

  protected shouldUpdate(changedProps: PropertyValues) {
    if (!changedProps.has("hass") || changedProps.size > 1) {
      return true;
    }

    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;

    if (!oldHass || !this._configEntities) {
      return true;
    }

    if (oldHass.themes.darkMode !== this.hass.themes.darkMode) {
      return true;
    }

    // Check if any state has changed
    for (const entity of this._configEntities) {
      if (oldHass.states[entity] !== this.hass!.states[entity]) {
        return true;
      }
    }

    return false;
  }

  protected firstUpdated(changedProps: PropertyValues): void {
    super.firstUpdated(changedProps);
    const root = this.shadowRoot!.getElementById("root");

    if (!this._config || this.isPanel || !root) {
      return;
    }

    if (!this._config.aspect_ratio) {
      root.style.paddingBottom = "100%";
      return;
    }

    const ratio = parseAspectRatio(this._config.aspect_ratio);

    root.style.paddingBottom =
      ratio && ratio.w > 0 && ratio.h > 0
        ? `${((100 * ratio.h) / ratio.w).toFixed(2)}%`
        : (root.style.paddingBottom = "100%");
  }

  protected updated(changedProps: PropertyValues): void {
    if (this._config?.hours_to_show && this._configEntities?.length) {
      if (changedProps.has("_config")) {
        this._getHistory();
      } else if (Date.now() - this._date!.getTime() >= MINUTE) {
        this._getHistory();
      }
    }
  }

  private _fitMap() {
    this._map?.fitMap();
  }

  private _getColor(entityId: string): string {
    let color = this._colorDict[entityId];
    if (color) {
      return color;
    }
    color = getColorByIndex(this._colorIndex);
    this._colorIndex++;
    this._colorDict[entityId] = color;
    return color;
  }

  private _getEntities = memoizeOne(
    (
      states: HassEntities,
      config: MapCardConfig,
      configEntities?: string[]
    ) => {
      if (!states || !config) {
        return undefined;
      }

      let entities = configEntities || [];

      if (config.geo_location_sources) {
        const geoEntities: string[] = [];
        // Calculate visible geo location sources
        const includesAll = config.geo_location_sources.includes("all");
        for (const stateObj of Object.values(states)) {
          if (
            computeDomain(stateObj.entity_id) === "geo_location" &&
            (includesAll ||
              config.geo_location_sources.includes(stateObj.attributes.source))
          ) {
            geoEntities.push(stateObj.entity_id);
          }
        }

        entities = [...entities, ...geoEntities];
      }

      return entities.map((entity) => ({
        entity_id: entity,
        color: this._getColor(entity),
      }));
    }
  );

  private _getHistoryPaths = memoizeOne(
    (
      config: MapCardConfig,
      history?: HassEntity[][]
    ): HaMapPaths[] | undefined => {
      if (!config.hours_to_show || !history) {
        return undefined;
      }

      const paths: HaMapPaths[] = [];

      for (const entityStates of history) {
        if (entityStates?.length <= 1) {
          continue;
        }
        // filter location data from states and remove all invalid locations
        const points = entityStates.reduce(
          (accumulator: LatLngTuple[], entityState) => {
            const latitude = entityState.attributes.latitude;
            const longitude = entityState.attributes.longitude;
            if (latitude && longitude) {
              accumulator.push([latitude, longitude] as LatLngTuple);
            }
            return accumulator;
          },
          []
        ) as LatLngTuple[];

        paths.push({
          points,
          color: this._getColor(entityStates[0].entity_id),
          gradualOpacity: 0.8,
        });
      }
      return paths;
    }
  );

  private async _getHistory(): Promise<void> {
    this._date = new Date();

    if (!this._configEntities) {
      return;
    }

    const entityIds = this._configEntities!.join(",");
    const endTime = new Date();
    const startTime = new Date();
    startTime.setHours(endTime.getHours() - this._config!.hours_to_show!);
    const skipInitialState = false;
    const significantChangesOnly = false;
    const minimalResponse = false;

    const stateHistory = await fetchRecent(
      this.hass,
      entityIds,
      startTime,
      endTime,
      skipInitialState,
      significantChangesOnly,
      minimalResponse
    );

    if (stateHistory.length < 1) {
      return;
    }
    this._history = stateHistory;
  }

  private _cleanupHistory() {
    if (!this._history) {
      return;
    }
    if (this._config!.hours_to_show! <= 0) {
      this._history = undefined;
    } else {
      // remove unused entities
      this._history = this._history!.reduce(
        (accumulator: HassEntity[][], entityStates) => {
          const entityId = entityStates[0].entity_id;
          if (this._configEntities?.includes(entityId)) {
            accumulator.push(entityStates);
          }
          return accumulator;
        },
        []
      ) as HassEntity[][];
    }
  }

  static get styles(): CSSResultGroup {
    return css`
      ha-card {
        overflow: hidden;
        width: 100%;
        height: 100%;
      }

      ha-map {
        z-index: 0;
        border: none;
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: inherit;
      }

      ha-icon-button {
        position: absolute;
        top: 75px;
        left: 3px;
        outline: none;
      }

      #root {
        position: relative;
        height: 100%;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-map-card": HuiMapCard;
  }
}
