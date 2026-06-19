/**
 * Environment Modeler
 * -------------------
 * Represents the broader environment in which the digital twin operates –
 * infrastructure topology, network characteristics, external data sources, etc.
 * The model is read‑only for the simulation engine; it can be queried to
 * enrich entity behaviour.
 */

/**
 * A generic description of an infrastructure component.
 */
export interface InfrastructureComponent {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

/**
 * The full environment model – a collection of infrastructure components and
 * optional metadata.
 */
export interface EnvironmentModel {
  components: InfrastructureComponent[];
  /** Arbitrary additional data (e.g., network latency matrix) */
  metadata?: Record<string, unknown>;
}

/**
 * Service responsible for providing the environment model. In a production
 * system this would load data from a configuration store or external API. For
 * the purpose of this repository we expose a simple in‑memory implementation.
 */
export class EnvironmentModeler {
  private model: EnvironmentModel = { components: [] };

  /** Load a model – replaces any existing data */
  public load(model: EnvironmentModel): void {
    this.model = model;
  }

  /** Retrieve the current model */
  public getModel(): EnvironmentModel {
    // Return a shallow copy to avoid accidental mutation by callers.
    return { ...this.model, components: [...this.model.components] };
  }
}
